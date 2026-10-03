# Testing

Every test is a flake check. `nix flake check` runs them all; one check runs on its own with
`nix build .#checks.<system>.<name> -L` (for example `nix build .#checks.x86_64-linux.wasmfs-idb -L`).
The checks build their programs, browsers and dependencies from the flake, run offline in the Nix
sandbox, and pass or fail as a derivation does. CI runs `nix flake check` on x86_64-linux
([tooling.md](tooling.md#ci)).

## Frameworks

Each kind of code has one structured framework. There are no ad-hoc `main()` programs with
`CHECK` macros, no `node:assert` scripts and no print-then-grep checks.

| Code                             | Framework                     | Run by                                             |
| -------------------------------- | ----------------------------- | -------------------------------------------------- |
| C and C++ that doesn't link GLib | GoogleTest (`pkgsWasm.gtest`) | the test-program shim                              |
| C that links GLib                | GLib's g_test, reporting TAP  | `meson test` under Node, or the shim               |
| TypeScript                       | Vitest                        | Vitest, through the shim or a package's own config |
| TypeScript written with Effect   | Vitest with `@effect/vitest`  | the package's Vitest config                        |

### GoogleTest

GoogleTest comes from `pkgsWasm.gtest`: nixpkgs' recipe cross-built for WebAssembly, a static
library with its `gtest.pc`, built with pthreads (`-DGTEST_HAS_PTHREAD=1`).

- **No death tests.** GoogleTest enables them only on platforms it knows can fork, keyed on macros
  such as `__linux__`, which emcc doesn't define. `EXPECT_DEATH` and friends aren't available.
- **`-sPROXY_TO_PTHREAD`.** Every GoogleTest program links with it, so `main()` and the tests run
  on a pthread while the program's own thread (a Worker's thread in a browser, Node's main thread)
  keeps its event loop. IndexedDB requests, `postMessage` and post-js callbacks all complete on
  that loop. A case that waits for one of them proxies a call to the main thread and blocks on a
  condition the JavaScript callback signals, which a test running on the main thread itself could
  never do without returning to the loop. The startup objects this needs (`crt1_proxy_main.o`,
  PIC and not) are in the frozen Emscripten cache
  ([toolchain.md](toolchain.md#the-frozen-library-cache)).
- **Cases about the main thread** (a blocked main thread, a `dlopen()` the main thread makes) hand
  their work to the main thread's event loop with a proxied `emscripten_set_timeout(..., 0)`, as
  `main()` itself would have run, and wait in futex waits. A synchronous proxied call doesn't
  work for these: it runs inside the main thread's processing of proxied calls, which can't be
  re-entered, so threads started on new Workers never run while it blocks.

### g_test

C that links GLib keeps GLib's own framework, g_test, whose output is TAP. GLib's own test suite
and libibus-web's tests run under `meson test` with Node as the cross file's exe wrapper
(`checks.glib-tests`, `checks.libibus-web`; [glib.md](glib.md) covers GLib's gate and baseline).
A g_test program can also run through the shim as a `tap` program, in Node or a browser; it must
then accept g_test's `-l`, `-s` and `--keep-going`, which the shim uses to list and select cases.

### Vitest

TypeScript tests use Vitest (version 5, one version across the repository through the pnpm
catalog, [tooling.md](tooling.md#the-pnpm-workspace)). Code written with Effect tests with
`@effect/vitest`. Checks run the shim's and packages' emitted `dist/`, but test files (`*.test.ts`)
run from source: Vitest compiles them through Vite, which is why the Nix workspace build carries
`tsconfig.base.json` beside the packages.

## The GoogleTest harness

`ibus-web-gtest-main` (`modules/testing/gtest-main/`) supplies `main()` for every GoogleTest
program, through `ibusWeb.testing.gtestMain`:

- `cflags`: GoogleTest's headers and `-DGTEST_HAS_PTHREAD=1`;
- `libs`: `-sPROXY_TO_PTHREAD=1`, the harness object, `-lgtest` and `--js-library` of the
  harness's JavaScript library;
- `jsLibrary`: that library's path.

How a report gets out:

1. `main()` creates a file of its own with `mkstemps("/tmp/gtest-report-XXXXXX.json")`. Under Node,
   WasmFS is rooted at the host's `/`, so `/tmp` is the host's, and two programs running at once
   would otherwise overwrite each other's report.
2. It appends `--gtest_output=json:<that file>` as the **last** argument before
   `testing::InitGoogleTest`. GoogleTest sets up its report while it parses its flags, so the flag
   must be among them, and being last, a program's own arguments can't redirect it.
3. After `RUN_ALL_TESTS()` it reads the file back, removes it, and calls
   `ibus_web_test_report(text, length)`, then returns GoogleTest's status.
4. `ibus_web_test_report` is a JavaScript library function proxied synchronously to the program's
   main thread (`__proxy: "sync"`). In a browser it posts
   `{ kind: "report", format: "gtest-json", text }` from the program's Worker to the page; under
   Node it writes the text to the path in `IBUS_WEB_TEST_REPORT`.

A program's last report wins. A program that exits without one fails as "no report". The library
is JSDoc-typed and checked like the other Emscripten-read JavaScript (`checks.gtest-main-library`:
its `__deps` are complete, and it type-checks against types generated from a link of it).

## The test-program shim

`@ibus-web/test-programs` (`packages/test-programs/`) runs WebAssembly test programs under Vitest
and turns each program's GoogleTest JSON report or TAP stream into one Vitest result per case.
`ibusWeb.testing.programs` (`modules/testing/default.nix`) makes a check that runs it.

### The manifest

Nix hands Vitest a JSON manifest in `IBUS_WEB_TEST_PROGRAMS`:

```json
{
  "timeout": 120,
  "environments": ["node", "chromium", "firefox"],
  "programs": [{ "name": "basic.1", "dir": "/nix/store/…", "format": "gtest-json" }],
  "nodeTests": { "dir": "/nix/store/…", "data": { "key": "value" } }
}
```

Each program directory holds `NAME.js`, `NAME.wasm` and optionally `NAME.args`, the program's
arguments one per line, which come before the shim's own. `format` is `gtest-json` or `tap`.
`timeout` is each program's limit in seconds, in each environment.

### Environments

- **node** — Vitest's node pool with a custom runner (`dist/node/runner.js`). Each program runs as
  a child `node NAME.js`, with `IBUS_WEB_TEST_REPORT` set and the timeout enforced with `SIGKILL`.
  TAP on stdout is parsed with `tap-parser`.
- **chromium**, **firefox** — Vitest browser mode with the Playwright provider, headless. Each
  program runs in a dedicated module Worker (`new Worker(url, { type: "module" })`) on a page
  served with cross-origin isolation; the Worker imports the program's factory, collects
  `print`/`printErr`, `onExit`, `onAbort` and the posted report. Programs and the Worker script are
  served as they are on disk by a middleware in the shim's Vite plugin, bypassing Vite's
  transforms. TAP is parsed in Node through a browser command, since `tap-parser` needs Node's
  `events`.

Programs for browsers link with `ibusWeb.testing.browserLinkFlags` (`-sMODULARIZE -sEXPORT_ES6
-sENVIRONMENT=worker -sEXIT_RUNTIME=1`, assertions on); programs for Node with
`ibusWeb.testing.nodeLinkFlags` (WasmFS with the host's files at their own paths, assertions on).

### Listing, running, results

While Vitest collects, every program runs once in list mode: GoogleTest's `--gtest_list_tests`,
whose report the harness hands over as JSON, or g_test's `-l`. The listing becomes nested suites:

```
ENVIRONMENT › PROGRAM › SUITE… › CASE
```

— GoogleTest's suites, the segments of a g_test path, or TAP subtests — and each program's suite
ends with a test named `run`. Vitest's `-t` pattern matches that path joined with `>`, e.g.
`-t '^firefox > seal > Seal > StillReads$'`.

When Vitest reaches a program's suite, its `beforeAll` runs the program **once**, restricted to the
cases Vitest selected: `--gtest_filter=A.B:…`, or for g_test `--keep-going` plus `-s PATH` for each
case not selected (several `-p` would print several TAP plans, which is broken TAP;
`--keep-going` stops g_test aborting at the first failure). Each case's test then replays the
program's result: passed, failed with the report's message, or skipped. A listed case the program
didn't report fails as "not reported".

`run` fails for problems with the run as a whole: the listing failed; the program didn't exit or
timed out; the report or TAP stream was broken (no plan, unmet plan, bail-out); it ran cases it
wasn't asked to; it exited non-zero with no failing case to explain it; or it is "not run"
because an earlier program of its sequence failed. `run` also fails if a case's reported time
didn't reach Vitest (below).

**Durations** are the program's own: GoogleTest's per-test and per-suite `time`, TAP's
`# time=`, and g_test's `# slow test PATH executed in N secs`. GLib prints the last only for tests
of 0.5 s or more, so fast g_test cases show Vitest's near-zero replay time. The program's suite
and its `run` get the run's wall time. In Node the custom runner sets them. Vitest 5's browser mode
ignores `test.runner`, so the browser test file wraps `TestRunner.prototype.onAfterRunTask` and
`onAfterRunSuite` instead; the `run` test's time check catches it if a Vitest update stops that
working.

### Selecting tests

`-t` selects cases, and the program runs only those. When the selection names cases of a later
program of a sequence, the earlier programs still run first for the storage they leave: one with
none of its cases selected runs in full (the catch-up run), one with some runs only those; if one
fails, the selected program is "not run". A `run` test selected
without any of its program's cases passes without running the program, so a pattern that leaves
out every `run` hides run-level failures ([known-gaps.md](known-gaps.md#testing)).

Cases inside one program run in GoogleTest's order. A suite whose cases build on each other (the
IndexedDB backend's `Basic`, for one) fails or skips when a filter picks a later case alone; those
suites say so in a `GTEST_SKIP` message.

### Sequences and storage

- Programs named `PREFIX.1`, `PREFIX.2`, … form a **sequence**. They run in that order and share
  one storage context: in a browser, the origin's storage, kept between them; under Node, one
  working directory. A sequence stops at its first failing program; the rest are "not run" and
  their cases skipped. The numbers start at 1 without gaps, and `PREFIX` can't also be a program
  of its own.
- **Every other program starts with storage cleared**: in a browser, `indexedDB.databases()` and a
  delete of each before the program starts; under Node, a fresh empty working directory.
  Listing runs in a directory of its own.

Persistence tests are sequences: the first program writes, the next one, a new process or Worker
on the same storage, reads back.

### Output

A program's stdout and stderr, and in browsers the page's console, are logged inside its tests and
shown only for failing tests (`silent: "passed-only"`). Two lines are dropped entirely: Firefox's
"WebAssembly exception handling 'try' instruction is deprecated", expected until the toolchain
moves to the standard exception encoding, and Playwright's "Skipping host requirements
validation", printed because Nix rather than the host's packages provides the browsers' libraries.

Output from a pthread that is still in transit when the runtime exits is lost: Emscripten stops
listening to its pthreads during exit. A program that wants all its threads' output joins them
first.

### Test files beside programs

`nodeTests` names a directory of Vitest files that run in the node environment beside the
programs, for what a program can't report on itself: the status it exits with, a `LinkError` its
module raises, a TypeScript module under test. The directory's `.ts` files are copied as they are
(so they keep their names and can import siblings; `tsconfig.json` is left out, since it extends
files not copied), and every `*.test.ts` among them runs. They import from `vitest`, and read
strings the check passes in `nodeTestData` with `nodeTestData(KEY)` from
`@ibus-web/test-programs/node-tests`; both resolve from the shim wherever the files are.
`programs` may be empty when `nodeTests` holds every test (`checks.ibus-runtime-load`,
`checks.wasmfs-idb-library-deps`, `checks.glib-tests-gate`).

## Adding a test program

`ibusWeb.testing.program` builds one program with pkgsWasm's stdenv (so the common flags apply);
`ibusWeb.testing.programs` makes the check. A minimal GoogleTest program for Node, after
`checks.emscripten-fixes` (`modules/emscripten/checks/fixes/`):

```cpp
// fstat-stdio.cpp
#include <errno.h>
#include <sys/stat.h>
#include <cstring>
#include <gtest/gtest.h>

namespace {

TEST(Patch0001, FstatStandardStreams) {
  for (int fd = 0; fd < 3; fd++) {
    struct stat st;
    EXPECT_EQ(fstat(fd, &st), 0) << "fd " << fd << ": " << strerror(errno);
  }
}

} // namespace
```

No `main()`: the harness provides it. In the directory's flake-parts module:

```nix
{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb) testing;
    in
    {
      checks.my-check = testing.programs {
        name = "my-check";
        environments = [ "node" ];
        programs = [
          (testing.program {
            name = "fstat-stdio"; # compiles fstat-stdio.cpp from src
            src = ./.;
            linkFlags = testing.nodeLinkFlags;
          })
        ];
      };
    };
}
```

The check reports `node › fstat-stdio › Patch0001 › FstatStandardStreams` and
`node › fstat-stdio › run`.

What `program` takes (its option description has the full list):

- `name`, `src`; `sources` (default `[ "NAME.cpp" ]`; `.c` files compile with `$CC`), and
  `extraSources` for other files the build reads. The build sees only those and the `.h` files in
  `src`.
- `linkFlags` (required), `cflags`, `libs`: strings or lists; the build's shell expands them, so
  they may name `$out`.
- `format`: `"gtest-json"` (default; compiles against GoogleTest and links `gtestMain`), `"tap"`,
  or `null` for a program the shim doesn't run.
- `args` (written to `NAME.args`), `preBuild` (runs with `$out` made, e.g. to build side modules
  beside the program), `nativeBuildInputs`, `buildInputs`, `derivationName`.

What `programs` takes: `name`; `programs`; `environments` (default chromium and firefox);
`timeout` (default 120 s per program); `nodeTests` and `nodeTestData`; `vitestArgs` (extra Vitest
arguments, such as `-t`); `expectedResults` (for the shim's own check). Its overall limit is each
program's timeout plus a minute, for every program in every environment and every test file, plus
five minutes.

For browser programs, link with `testing.browserLinkFlags` and size the pthread pool: a program
whose threads must start while the main thread is busy needs them pre-spawned
(`-sPTHREAD_POOL_SIZE`, one for GoogleTest's own thread plus the case's), and
`-sPTHREAD_POOL_SIZE_STRICT=2` makes a pool that falls short fail the case that needed a thread
rather than slow it down (`runtime/wasmfs-idb/checks.nix` counts them per program).

Editor flags: add the GoogleTest flags for the new sources to clangd with
`ibusWeb.toolchain.clangdPathFlags."<path regex>" = testing.gtestCflagList;`, or `checks.clangd`
fails on `gtest/gtest.h` ([tooling.md](tooling.md#editor-tooling)).

## Engine golden tests and audits

An engine owns its golden traces under `engines/<name>/checks/`. Hangul's
`checks.hangul-golden` uses a g_test main module with assertions and the actual
engine side module. It mounts the package's data at FHS paths, sends framed
runtime requests and decodes records with GVariant/IBus. Its 15 cases cover
composition, candidates, focus, settings (including changes with zero instances),
lifetime, surrounding text and event ordering. The shim reports those cases and a run-completion check under Node.
See [engines.md](engines.md#golden-tests) for the harness and the port bugs it
reproduced. These are WASM behavior tests; native differential comparison is a
separate follow-up.

`checks.hangul-cast-audit` and `checks.libibus-web-cast-audit` compile real
sources with Clang's strict function-cast warning and compare the structured
report with committed JSONC allow-lists. The parser and comparison have Vitest
tests in `tools/cast-audit`; a compiled C fixture also proves that an empty
allow-list rejects incompatible casts. The audit does not cover signal
connection arity. `checks.hangul-imports` checks runtime symbol compatibility.

`checks.glib-settings-listeners` owns the regression for GLib patch 0018: ten
g_test cases exercise five listener signatures, in direct and queued delivery,
using GLib's memory backend. This does not depend on the IBus settings backend.

## Browsers

The browsers are nixpkgs' `playwright-driver` builds — Chromium's headless shell and Firefox, with
the full Chromium, WebKit and ffmpeg left out of the closure — so the workspace's `playwright`
package must be exactly `playwright-driver`'s version, which the Nix build asserts
([tooling.md](tooling.md#the-pnpm-workspace)). `ibusWeb.testing.playwright` holds them:

- `env`: `PLAYWRIGHT_BROWSERS_PATH`, `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`,
  `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1` (Nix links the browsers' libraries; Playwright
  would look for the host's distribution packages), and `IBUS_WEB_CHROMIUM_SANDBOX`.
- `chromiumSandbox` (default true): Chromium keeps its own sandbox, as a browser does. It needs
  unprivileged user namespaces, which the Nix sandbox allows on Linux unless the builder forbids
  them (Ubuntu 24.04's AppArmor does by default; CI lifts that with a `sysctl` step,
  [tooling.md](tooling.md#ci)); on such a builder, set it to false.
- `setup`: a fresh `HOME`. Firefox writes its XDG directories under `HOME` as it starts and hangs
  before Playwright can connect if it can't.

Every response the test server sends, errors included, carries
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`: without
cross-origin isolation there is no `SharedArrayBuffer`, so no program with threads.

The shim's and the Worker host's Vitest configurations share what a browser run needs, from
`@ibus-web/test-programs/vitest`: `crossOriginIsolation` (those headers), `serveDirs` and
`servePlugin` (directories served under a URL prefix as they are on disk, which Vite would
rewrite, with Vite's warning about Vitest's own module runner dropped), and `browserMode`
(Playwright's headless browsers, Chromium with `chromiumSandbox`, Playwright's notice that it
skips host validation dropped). `ibusWeb.testing.vitestCheck` runs a package's suites from the
built workspace as a check, for `ibusWeb.testing.programs` and the Worker host alike; its output
keeps Vitest's console output (`output.txt`) and JSON report (`results.json`).

## Running tests locally

- **One check:** `nix build .#checks.x86_64-linux.<name> -L`. A check that passed is cached; add
  `--rebuild` to run it again.
- **Vitest from the checkout,** against a check's built programs, without rebuilding the check:
  enter the dev shell, build the shim (`pnpm install` once, then `pnpm -r run build` or
  `pnpm run build` in `packages/test-programs`), and point it at the check's manifest. The
  manifest and the programs it names exist once the check has been built.

  ```sh
  check=.#checks.x86_64-linux.emscripten-fixes
  nix build "$check"     # builds the programs and the manifest
  cd packages/test-programs
  IBUS_WEB_TEST_PROGRAMS=$(nix eval --raw "$check.IBUS_WEB_TEST_PROGRAMS") pnpm test -t 'fstat-stdio'
  ```

  Browser checks also need the browsers' environment, which the dev shell doesn't set:

  ```sh
  check=.#checks.x86_64-linux.wasmfs-idb
  IBUS_WEB_TEST_PROGRAMS=$(nix eval --raw "$check.IBUS_WEB_TEST_PROGRAMS") \
  PLAYWRIGHT_BROWSERS_PATH=$(nix eval --raw "$check.PLAYWRIGHT_BROWSERS_PATH") \
  PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1 \
    pnpm test -t 'seal > Seal'
  ```

  This runs the shim from the checkout, so a change to the shim takes effect after
  `pnpm run build`; a change to a program needs the check (or the program) rebuilt.

- **Worker host:** its checks carry `passthru.manifest` for the same purpose
  ([worker-host.md](worker-host.md)).

## Reading failures

Vitest's default reporter prints each failing test with its message: GoogleTest's file, line and
expectation, a TAP diagnostic, or the shim's own message for `run` ("no report", "listing failed:
…", "ran cases it wasn't asked to run: …", "not run: basic.1 failed"). The program's stdout and
stderr follow, for failing tests only. Under assertions with `-sPROXY_TO_PTHREAD`, Emscripten
prints `received "7" command from terminated worker` as a program exits; it is harmless.

The check's derivation also writes Vitest's JSON report to `$out/results.json` (on success; a
failed build keeps no output unless run with `--keep-failed`).

## Checks that aren't tests

Checks whose only assertion is that something builds or links, and lint-style consistency checks,
aren't tests and don't use a test framework. The main ones:

- `hk`: formatting, oxlint, `tsc`, the `tsconfig` extends chain, REUSE, actionlint
  ([tooling.md](tooling.md#hk)).
- `clangd`: every C and C++ source parses under the editor configuration.
- `files:.github/workflows/ci.yml`: the tracked workflow matches its Nix.
- `ibus-runtime-exports`, `ibus-runtime-side-imports`, `worker-host-side-imports`: the runtime's
  export manifest against its libraries, and side modules' imports against it.
- `wasmfs-idb-types`, `wasmfs-idb-acorn`, `gtest-main-library`: Emscripten-read JavaScript checked
  against generated types and its declared dependencies; the checker's acorn pinned to
  Emscripten's.
- `glib-patches`, `toolchain-cache`, `toolchain-exnref`, `cross-toolchain`, `meson-consumer`,
  `libhangul-wasm`: the toolchain and packages build, link and apply as expected
  ([toolchain.md](toolchain.md), [glib.md](glib.md)).
