# Testing

`nix flake check` runs the default correctness gates. Extended integration matrices run with
`nix build .#integration-checks -L`; they are registered in `ibusWeb.testing.extendedChecks`. One default check runs
with `nix build .#checks.<system>.<name> -L` (for example `nix build .#checks.x86_64-linux.wasmfs-idb-browser -L`). Both
tiers build their programs, browsers and dependencies from the flake and run offline in the Nix sandbox. CI runs
separate default and extended jobs on x86_64-linux; master publication requires both to pass
([tooling.md](tooling.md#ci)).

## Frameworks

Each kind of code has one structured framework. There are no ad-hoc `main()` programs with `CHECK` macros, no
`node:assert` scripts and no print-then-grep checks.

| Code                             | Framework                     | Run by                                             |
| -------------------------------- | ----------------------------- | -------------------------------------------------- |
| C and C++ that doesn't link GLib | GoogleTest (`pkgsWasm.gtest`) | the test-program shim                              |
| C that links GLib                | GLib's g_test, reporting TAP  | `meson test` under Node, or the shim               |
| TypeScript                       | Vitest                        | Vitest, through the shim or a package's own config |
| TypeScript written with Effect   | Vitest with `@effect/vitest`  | the package's Vitest config                        |

### GoogleTest

GoogleTest comes from `pkgsWasm.gtest`: nixpkgs' recipe cross-built for WebAssembly, a static library with its
`gtest.pc`, built with pthreads (`-DGTEST_HAS_PTHREAD=1`).

- **No death tests.** GoogleTest enables them only on platforms it knows can fork, keyed on macros such as `__linux__`,
  which emcc doesn't define. `EXPECT_DEATH` and friends aren't available.
- **`-sPROXY_TO_PTHREAD`.** Every GoogleTest program links with it, so `main()` and the tests run on a pthread while the
  program's own thread (a Worker's thread in a browser, Node's main thread) keeps its event loop. IndexedDB requests,
  `postMessage` and post-js callbacks all complete on that loop. A case that waits for one of them proxies a call to the
  main thread and blocks on a condition the JavaScript callback signals, which a test running on the main thread itself
  could never do without returning to the loop. The startup objects this needs (`crt1_proxy_main.o`, PIC and not) are in
  the frozen Emscripten cache ([toolchain.md](toolchain.md#the-frozen-library-cache)).
- **Cases about the main thread** (a blocked main thread, a `dlopen()` the main thread makes) hand their work to the
  main thread's event loop with a proxied `emscripten_set_timeout(..., 0)`, as `main()` itself would have run, and wait
  in futex waits. A synchronous proxied call doesn't work for these: it runs inside the main thread's processing of
  proxied calls, which can't be re-entered, so threads started on new Workers never run while it blocks.

### g_test

C that links GLib keeps GLib's own framework, g_test, whose output is TAP. GLib's own test suite and libibus-web's tests
run under `meson test` with Node as the cross file's exe wrapper (`checks.glib-tests`, `checks.libibus-web-tests`;
[glib.md](glib.md) covers GLib's gate and baseline). A g_test program can also run through the shim as a `tap` program,
in Node or a browser; it must then accept g_test's `-l`, `-s` and `--keep-going`, which the shim uses to list and select
cases.

### Vitest

TypeScript tests use Vitest (version 5, one version across the repository through the pnpm catalog,
[tooling.md](tooling.md#the-pnpm-workspace)). Code written with Effect tests with `@effect/vitest`. Checks run the
shim's and packages' emitted `dist/`, but test files (`*.test.ts`) run from source: Vitest compiles them through Vite,
which is why the Nix workspace build carries the `@ibus-web/tsconfig` presets (`packages/tsconfig/`) beside the
packages.

## The GoogleTest harness

`ibus-web-gtest-main` (`modules/testing/gtest-main/`) supplies `main()` for every GoogleTest program. A program compiles
with `ibusWeb.testing.gtestCflagList` (GoogleTest's headers and `-DGTEST_HAS_PTHREAD=1`) and links with
`ibusWeb.testing.gtestLinkFlags` (`-sPROXY_TO_PTHREAD=1`, the harness object, `-lgtest` and `--js-library` of the
harness's JavaScript library); `ibusWeb.testing.program` adds both to a GoogleTest program itself.

How a report gets out:

1. `main()` creates a file of its own with `mkstemps("$TMPDIR/gtest-report-XXXXXX.json")`, in `/tmp` without a `TMPDIR`.
   Under Node, WasmFS is rooted at the host's `/`, so `/tmp` is the host's, and two programs running at once would
   otherwise overwrite each other's report; the shim gives each Node run a `TMPDIR` it removes afterwards, so a program
   that crashes before removing its report leaves nothing behind.
2. It appends `--gtest_output=json:<that file>` as the **last** argument before `testing::InitGoogleTest`. GoogleTest
   sets up its report while it parses its flags, so the flag must be among them, and being last, a program's own
   arguments can't redirect it.
3. After `RUN_ALL_TESTS()` it reads the file back, removes it, and calls `ibus_web_test_report(text, length)`, then
   returns GoogleTest's status.
4. `ibus_web_test_report` is a JavaScript library function proxied synchronously to the program's main thread
   (`__proxy: "sync"`). In a browser it posts `{ kind: "report", format: "gtest-json", text }` from the program's Worker
   to the page; under Node it writes the text to the path in `IBUS_WEB_TEST_REPORT`.

A program's last report wins. A program that exits without one fails as "no report". The library is JSDoc-typed and
checked like the other Emscripten-read JavaScript (`checks.testing-gtest-main-library`: its `__deps` are complete, and
it type-checks against types generated from a link of it).

## The test-program shim

`@ibus-web/test-programs` (`packages/test-programs/`) runs WebAssembly test programs under Vitest and turns each
program's GoogleTest JSON report or TAP stream into one Vitest result per case. `ibusWeb.testing.programs`
(`modules/testing/programs.nix`) makes a check that runs it.

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

Each program directory holds `NAME.js`, which carries its WebAssembly
([toolchain.md](toolchain.md#the-compiler-wrapper)), and optionally `NAME.args`, the program's arguments one per line,
which come before the shim's own. `format` is `gtest-json` or `tap`. `timeout` is each program's limit in seconds, in
each environment.

### Environments

- **node** — Vitest's node pool with a custom runner (`dist/node/runner.js`). Each program runs as a child
  `node NAME.js`, with `IBUS_WEB_TEST_REPORT` set and the timeout enforced with `SIGKILL`. Its stdout and stderr are
  pipes, and a program writing faster than the shim reads waits for it. Node makes those pipes non-blocking once a
  pthread's Worker is constructed, so that waiting comes from the toolchain's Emscripten
  ([patch 0020](../modules/emscripten/patches/README.md)): unpatched, a burst the shim hasn't read yet comes out short
  or fails with `EAGAIN`, which the `large-output` fixture of `checks.testing-programs` checks for. TAP on stdout is
  parsed with `tap-parser`.
- **chromium**, **firefox** — Vitest browser mode with the Playwright provider, headless. Each program runs in a
  dedicated module Worker (`new Worker(url, { type: "module" })`) on a page served with cross-origin isolation; the
  Worker imports the program's factory, collects `print`/`printErr`, `onExit`, `onAbort` and the posted report. Programs
  and the Worker script are served as they are on disk by a middleware in the shim's Vite plugin, bypassing Vite's
  transforms. TAP is parsed in Node through a browser command, since `tap-parser` needs Node's `events`.

Programs for browsers link with `ibusWeb.testing.browserLinkFlags`
(`-sMODULARIZE -sEXPORT_ES6 -sENVIRONMENT=worker -sEXIT_RUNTIME=1`, assertions on); programs for Node with
`ibusWeb.testing.nodeLinkFlags` (WasmFS with the host's files at their own paths, assertions on).

### Listing, running, results

While Vitest collects, every program runs once in list mode: GoogleTest's `--gtest_list_tests`, whose report the harness
hands over as JSON, or g_test's `-l`. The listing becomes nested suites:

```
ENVIRONMENT › PROGRAM › SUITE… › CASE
```

— GoogleTest's suites, the segments of a g_test path, or TAP subtests — and each program's suite ends with a test named
`run`. Vitest's `-t` pattern matches that path joined with `>`, e.g. `-t '^firefox > seal > Seal > StillReads$'`.

When Vitest reaches a program's suite, its `beforeAll` runs the program **once**, restricted to the cases Vitest
selected: `--gtest_filter=A.B:…`, or for g_test `--keep-going` plus `-s PATH` for each case not selected (several `-p`
would print several TAP plans, which is broken TAP; `--keep-going` stops g_test aborting at the first failure). Each
case's test then replays the program's result: passed, failed with the report's message, or skipped. A listed case the
program didn't report fails as "not reported".

`run` fails for problems with the run as a whole: the listing failed; the program didn't exit or timed out; the report
or TAP stream was broken (no plan, unmet plan, bail-out); it ran cases it wasn't asked to; it exited non-zero with no
failing case to explain it; or it is "not run" because an earlier program of its sequence failed. `run` also fails if a
case's reported time didn't reach Vitest (below).

**Durations** are the program's own: GoogleTest's per-test and per-suite `time`, TAP's `# time=`, and g_test's
`# slow test PATH executed in N secs`. GLib prints the last only for tests of 0.5 s or more, so fast g_test cases show
Vitest's near-zero replay time. The program's suite and its `run` get the run's wall time. In Node the custom runner
sets them. Vitest 5's browser mode ignores `test.runner`, so the browser test file wraps
`TestRunner.prototype.onAfterRunTask` and `onAfterRunSuite` instead; the `run` test's time check catches it if a Vitest
update stops that working.

### Selecting tests

`-t` selects cases, and the program runs only those, but for a program of a sequence, which runs whole whenever any of
its cases is selected, since its cases may build on the ones before them. When the selection names cases of a later
program of a sequence, the earlier programs still run first, whole, for the storage they leave (the catch-up run); if
one fails, the selected program is "not run", and its `run` test shows the catch-up run's output and why it failed. A
case of a sequence program that wasn't selected but failed fails the program's `run`. A `run` test selected without any
of its program's cases passes without running the program. When a pattern leaves a program's `run` out, its selected
cases carry what `run` would have reported: each fails with the run's problem, and a program that was "not run" fails
its selected cases rather than skipping them.

Cases inside one program run in GoogleTest's order. Outside sequences, a suite whose cases build on each other fails or
skips when a filter picks a later case alone, and should say so in a `GTEST_SKIP` message.

### Sequences and storage

- Programs named `PREFIX.1`, `PREFIX.2`, … form a **sequence**. They run in that order and share one storage context: in
  a browser, the origin's storage, kept between them; under Node, one working directory. A sequence stops at its first
  failing program; the rest are "not run" and their cases skipped. The numbers start at 1 without gaps, and `PREFIX`
  can't also be a program of its own.
- **Every other program starts with storage cleared**: in a browser, `indexedDB.databases()` and a delete of each before
  the program starts; under Node, a fresh empty working directory. Listing runs in a directory of its own.

Persistence tests are sequences: the first program writes, the next one, a new process or Worker on the same storage,
reads back.

### Output

A program's stdout and stderr, and in browsers the page's console, are logged inside its tests and shown only for
failing tests (`silent: "passed-only"`). Two lines are dropped entirely: Firefox's "WebAssembly exception handling 'try'
instruction is deprecated", expected until the toolchain moves to the standard exception encoding, and Playwright's
"Skipping host requirements validation", printed because Nix rather than the host's packages provides the browsers'
libraries.

Output from a pthread that is still in transit when the runtime exits is lost: Emscripten stops listening to its
pthreads during exit. A program that wants all its threads' output joins them first.

### Test files beside programs

`nodeTests` names a directory of Vitest files that run in the node environment beside the programs, for what a program
can't report on itself: the status it exits with, a `LinkError` its module raises, a TypeScript module under test. The
directory's `.ts` files but declarations are copied as they are (so they keep their names and can import siblings;
`tsconfig.json` is left out, since it extends files not copied), and every `*.test.ts` among them runs. They import from
`vitest`, and read strings the check passes in `nodeTestData` with `nodeTestData(KEY)` from
`@ibus-web/test-programs/node-tests`; both resolve from the shim wherever the files are. `programs` may be empty when
`nodeTests` holds every test (`checks.ibus-runtime-load`, `checks.tools-emscripten-library-deps`,
`checks.glib-tests-gate`).

## Adding a test program

`ibusWeb.testing.program` builds one program with pkgsWasm's stdenv (so the common flags apply);
`ibusWeb.testing.programs` makes the check. A minimal GoogleTest program for Node, after `checks.emscripten-fixes`
(`modules/emscripten/checks/fixes/`):

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

The check reports `node › fstat-stdio › Patch0001 › FstatStandardStreams` and `node › fstat-stdio › run`.

What `program` takes (its option description has the full list):

- `name`, `src`; `sources` (default `[ "NAME.cpp" ]`; `.c` files compile with `$CC`), and `extraSources` for other files
  the build reads. The build sees only those and the `.h` files in `src`.
- `linkFlags` (required), `cflags`, `libs`: strings or lists; the build's shell expands them, so they may name `$out`.
- `format`: `"gtest-json"` (default; compiles against GoogleTest and links its harness), `"tap"`, or `null` for a
  program the shim doesn't run.
- `args` (written to `NAME.args`), `preBuild` (runs with `$out` made, e.g. to build side modules beside the program),
  `nativeBuildInputs`, `buildInputs`, `derivationName`.

What `programs` takes: `name`; `programs`; `environments` (default chromium and firefox); `timeout` (default 120 s per
program); `nodeTests` and `nodeTestData`; `vitestArgs` (extra Vitest arguments, such as `-t`); `expectedResults` (for
the shim's own check). Its overall limit is each program's timeout plus a minute, for every program in every environment
and every test file, plus five minutes.

For browser programs, link with `testing.browserLinkFlags` and size the pthread pool: a program whose threads must start
while the main thread is busy needs them pre-spawned (`-sPTHREAD_POOL_SIZE`, one for GoogleTest's own thread plus the
case's), and `-sPTHREAD_POOL_SIZE_STRICT=2` makes a pool that falls short fail the case that needed a thread rather than
slow it down (`runtime/wasmfs-idb/checks.nix` counts them per program).

Editor flags: add the GoogleTest flags for the new sources to clangd with
`ibusWeb.toolchain.clangdPathFlags."<path regex>" = testing.gtestCflagList;`, or `checks.toolchain-clangd` fails on
`gtest/gtest.h` ([tooling.md](tooling.md#editor-tooling)).

## Engine golden tests and audits

An engine owns its golden traces under `engines/<name>/checks/`. Hangul's `checks.hangul-golden` uses a g_test main
module with assertions and the actual engine side module. It mounts the package's store-path data, sends framed runtime
requests and decodes records with GVariant/IBus. Its 16 behavioral cases cover composition, candidates (page-relative
clicks included), focus, settings (including changes with zero instances), lifetime, surrounding text and event
ordering. The fixture resets the engine's settings to their defaults, plus Init's `hanja-keys`, before each case, and
the lifecycle case checks the settings handlers left after destruction. The shim reports those cases and a
run-completion check under Node, 17 tests in total. See [engines.md](engines.md#golden-tests) for the harness and the
port bugs it reproduced. `checks.hangul-differential` separately replays ten engine-owned traces through private
stock-native IBus sessions and the WASM engine, comparing ordered typed output and checking coverage assertions for each
scenario. Its retained `results` output includes both transcripts and process diagnostics; see
[the adapter contract](../tools/ibus-test/README.md).

`checks.hangul-cast-audit` and `checks.libibus-web-cast-audit` compile real sources with Clang's strict function-cast
warning and compare the structured report with committed JSONC allow-lists, which are validated against their schema
(Ajv) at run time. `checks.hangul-cast-audit` makes two runs, the engine (its inputs from the overlay's `passthru`) and
the private libhangul (`engines/hangul/libhangul-cast-audit.jsonc`); both allow-lists are empty.
`checks.libibus-web-cast-audit` covers every C translation unit of libibus-web, generated ones included, with a list
derived from the source directories and checked against Meson's `compile_commands.json`; the C++ `call-op.cpp` is not
audited. The parser and comparison have Vitest tests in `tools/cast-audit`; a compiled C fixture also proves that an
empty allow-list rejects incompatible casts. The audit does not cover signal connection arity. `checks.hangul-imports`
checks runtime symbol compatibility.

`checks.libibus-web-vendored` checks the vendored IBus tree against its inventory and the build's IBus source
([runtime.md](runtime.md#ibus-layer)); `checks.tools-vendor-inventory` runs the checker's Vitest suite.

`checks.glib-settings-listeners` owns the regression for GLib patch 0018: ten g_test cases exercise five listener
signatures, in direct and queued delivery, using GLib's memory backend. This does not depend on the IBus settings
backend.

## Browsers

The browsers are nixpkgs' `playwright-driver` builds — Chromium's headless shell, Firefox and WebKit, with the full
Chromium and ffmpeg left out of the closure — so the workspace's `playwright` package must be exactly
`playwright-driver`'s version, which the Nix build asserts ([tooling.md](tooling.md#the-pnpm-workspace)).
`ibusWeb.testing.playwright` holds them:

- `env`: `PLAYWRIGHT_BROWSERS_PATH`, `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`,
  `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1` (Nix links the browsers' libraries; Playwright would look for the
  host's distribution packages), and `IBUS_WEB_CHROMIUM_SANDBOX`. The dev shell exports it too.
- `chromiumSandbox` (default true): Chromium keeps its own sandbox, as a browser does. It needs unprivileged user
  namespaces, which the Nix sandbox allows on Linux unless the builder forbids them (Ubuntu 24.04's AppArmor does by
  default; CI lifts that with a `sysctl` step, [tooling.md](tooling.md#ci)); on such a builder, set it to false.
- `setup`: a fresh `HOME`. Firefox writes its XDG directories under `HOME` as it starts and hangs before Playwright can
  connect if it can't.
- `inChecks` (false on Darwin): whether the flake's checks launch browsers. The checks that do are declared in
  `ibusWeb.testing.browserChecks`, which become checks where it holds, and the shim's own test leaves out its browser
  fixtures where it doesn't.

Every response the test server sends, errors included, carries `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`: without cross-origin isolation there is no `SharedArrayBuffer`, so no
program with threads.

The shim's and the Worker host's Vitest configurations share what a browser run needs, from
`@ibus-web/test-programs/vitest`: `crossOriginIsolation` (those headers), `serveDirs` and `servePlugin` (directories
served under a URL prefix as they are on disk, which Vite would rewrite, with Vite's warning about Vitest's own module
runner dropped), and `browserMode` (Playwright's headless browsers, Chromium with `chromiumSandbox`, Playwright's notice
that it skips host validation dropped). `ibusWeb.testing.vitestCheck` runs a package's suites from the built workspace
as a check, for `ibusWeb.testing.programs` and the Worker host alike; its output keeps Vitest's console output
(`output.txt`) and JSON report (`results.json`).

## Running tests locally

- **One check:** `nix build .#checks.x86_64-linux.<name> -L`. A check that passed is cached; to run it again, delete its
  output (`nix store delete $(nix path-info .#checks.x86_64-linux.<name>)`) and build it: `--rebuild` would fail it,
  since its `results.json` differs from run to run.
- **Vitest from the checkout,** against a check's built programs, without rebuilding the check: enter the dev shell,
  build the shim (`pnpm install` once, then `pnpm -r run build` or `pnpm run build` in `packages/test-programs`), and
  point it at the check's manifest. The manifest and the programs it names exist once the check has been built.

  ```sh
  check=.#checks.x86_64-linux.emscripten-fixes
  nix build "$check"     # builds the programs and the manifest
  cd packages/test-programs
  IBUS_WEB_TEST_PROGRAMS=$(nix eval --raw "$check.IBUS_WEB_TEST_PROGRAMS") pnpm test -t 'fstat-stdio'
  ```

  Browser checks run the same way: the dev shell exports `ibusWeb.testing.playwright.env`, so Vitest launches the
  checks' own browsers.

  ```sh
  check=.#checks.x86_64-linux.wasmfs-idb-browser
  IBUS_WEB_TEST_PROGRAMS=$(nix eval --raw "$check.IBUS_WEB_TEST_PROGRAMS") pnpm test -t 'seal > Seal'
  ```

  This runs the shim from the checkout, so a change to the shim takes effect after `pnpm run build`; a change to a
  program needs the check (or the program) rebuilt.

- **Worker host:** its checks carry `passthru.manifest` for the same purpose ([worker-host.md](worker-host.md)).

## Reading failures

Vitest's default reporter prints each failing test with its message: GoogleTest's file, line and expectation, a TAP
diagnostic, or the shim's own message for `run` ("no report", "listing failed: …", "ran cases it wasn't asked to run:
…", "not run: basic.1 failed"). The program's stdout and stderr follow, for failing tests only. Under assertions with
`-sPROXY_TO_PTHREAD`, Emscripten prints `received "7" command from terminated worker` as a program exits; it is
harmless.

The check's derivation also writes Vitest's JSON report to `$out/results.json` (on success; a failed build keeps no
output unless run with `--keep-failed`).

## Checks that aren't tests

Checks whose only assertion is that something builds or links, and lint-style consistency checks, aren't tests and don't
use a test framework. The main ones:

- `flake-hk`: formatting, oxlint, `tsc`, the `tsconfig` extends chain, REUSE, actionlint ([tooling.md](tooling.md#hk)).
- `toolchain-clangd`: every C and C++ source parses under the editor configuration.
- `files:.github/workflows/ci.yml`: the tracked workflow matches its Nix.
- `ibus-runtime-exports`, `ibus-runtime-side-imports`, `worker-host-side-imports`: the runtime's export manifest against
  its libraries, and side modules' imports against it.
- `wasmfs-idb-types`, `tools-emscripten-library-deps-acorn`, `testing-gtest-main-library`: Emscripten-read JavaScript
  checked against generated types and its declared dependencies; the checker's acorn pinned to Emscripten's.
- `glib-patches`, `toolchain-cache`, `toolchain-exnref`, `toolchain-cross`, `toolchain-meson-consumer`,
  `hangul-libhangul-link`: the toolchain and packages build, link and apply as expected ([toolchain.md](toolchain.md),
  [glib.md](glib.md)).

## JavaScript modules

`checks.module-kit-node` runs the kit's Vitest suites under Node: definitions, settings, candidates, properties and
transform engines, the post-processor and its errors, the `ibus-web-module` command and the plugin's output. Because
every bundler is a pinned dev dependency of a fixture package, not of the kit, `checks.module-kit-bundlers`
(`packages/module-kit/checks/bundlers`) is a check of its own: it builds the kit's fixture module and
[`examples/pinyin-tones`](../examples/pinyin-tones/README.md) with Vite, Rollup, Rolldown, esbuild, webpack and Rspack,
compares each manifest and `settings.json` with the command line's, checks each bundler's source map beside the script,
and exercises Vite's dev server, `?ibus-module` import and `vite build --watch`
([module-kit.md](module-kit.md#the-bundler-plugin)). `checks.example-pinyin-tones-node` runs the example's own tests.
The example's end-to-end tests are the demo's ([below](#production-playwright-integration)).

## TypeScript protocol

`checks.protocol-node` runs the package's Vitest suites under Node: GVariant vectors, strict rejection cases, schema and
framing tests, generated-header/document tests, and fixed-seed Effect `Arbitrary` round trips, including encodings
mutated by one to three bytes and containers whose framing offsets are 1, 2 and 4 bytes wide. Every request and record
kind round trips through both directions of the codecs (`encodeRequest`/`decodeRequest`, `encodeRecord`/`decodeRecord`),
and the framing refusals of the host-side pair are tested. The default Vitest configuration leaves out the parity suite
and the decode benchmark.

The transport's ring has four kinds of test beyond its unit cases:

- **Fuzz** (`ring-fuzz.test.ts`): fixed-seed plans of record sizes and reads on 64-, 128-, 256- and 1024-byte rings,
  from counters at zero, just before the 2³² wrap at several distances, and across the sign bit. Every record arrives
  once, in order and unchanged, and whenever a write returns `full`, freeing exactly `needBytes` lets the next write
  publish a fragment.
- **Two threads** (`ring-threads.test.ts`): a writer in a `worker_thread` pushes 20,000 records through the full-ring
  wait while the test thread reads, on small rings and from counters near the wrap; every record arrives in order.
- **Exhaustive `needBytes`**: on a 64-byte ring, every write position, free amount and payload size up to three rings
  that returns `full` asks for exactly the least space with which the next write publishes a fragment: `needBytes` free
  makes progress, 8 bytes less doesn't.
- **Bad counters**: a `ringRead` past `ringWrite`, which claims more than the ring holds, makes both the writer and the
  reader throw.

`checks.protocol-parity` supplies a Nix-built corpus and a WASM C fixture producer using real IBus and json-glib, and
runs the parity suite (`vitest.parity.config.ts`). Vitest asserts both directions of object serialization, every
request's observed runtime arguments and result, every emitted record's fields and sequence, that `decodeRequest` reads
every corpus request and `encodeRecord` reproduces each emitted record's bytes, and that the strict decoder accepts
exactly the inputs GLib's `g_variant_is_normal_form` does, with no exceptions, on 1000 fixed-seed byte strings: mutated
normal-form encodings, unmutated ones and large containers. The test also requires the corpus to stay non-trivial (at
least 40% normal form, at least 30% not, at least 100 signatures, offsets of widths 1, 2 and 4 among the accepted
inputs). The suite throws without `IBUS_WEB_PROTOCOL_PARITY`, so the check fails rather than skips if it loses its
manifest.

The `files:runtime/libibus-web/include/ibus-web/protocol.h` and `files:packages/protocol/PROTOCOL.md` checks compare
generated artifacts to their committed copies. Regenerate with `nix run .#write-files`.

The decode benchmark is not a check, since wall-clock timing on a loaded builder means nothing:
`nix run .#protocol-bench` runs it and prints the median and p99 of each layer. See [protocol.md](protocol.md) for the
pipeline, the method and the figures.

## Worker transport and engine resources

```sh
nix build .#checks.x86_64-linux.worker-host-node
nix build .#checks.x86_64-linux.worker-host-browser
nix build .#checks.x86_64-linux.hangul-host
nix build .#checks.x86_64-linux.table-host
nix build .#checks.x86_64-linux.mozc-host
nix build .#checks.x86_64-linux.m17n-host
nix build .#checks.x86_64-linux.rime-host
nix build .#checks.x86_64-linux.tools-engine-manifest
nix build .#checks.x86_64-linux.hangul-data-closure
```

The default WorkerHost Node gate runs deterministic unit tests without runtime fixtures. The default browser gate runs
twelve real Worker smoke cases: `protocolRoundtrip`, `replySequence` and `jsModuleSmoke`, each on asserting and released
runtimes in Chromium and Firefox. They prove startup, request/reply results and ordered protocol output without storage
contention or tight heartbeat timing; `jsModuleSmoke` starts the hand-written JavaScript module (its script imported by
URL in the host's Worker) and types a key on its `trace` engine. The small real Hangul host conformance gate remains
default.

The full WorkerHost matrices, including storage, installation/upgrade contention, heartbeat liveness and stress, run
explicitly:

```sh
nix build .#worker-host-node-integration .#worker-host-browser-integration -L
# All registered extended checks, including future end-to-end matrices:
nix build .#integration-checks -L
```

`ibusWeb.typescript.workspaceFor [ "packages/worker-host" ]` builds the host, protocol and test-programs workspace
dependency closure using the shared offline install and build machinery. Source-only edits to excluded packages such as
core leave WorkerHost and Hangul host checks cached. Manifest, lockfile and shared configuration changes still
invalidate relevant inputs; other checks may use the complete `ibusWeb.typescript.workspace`.

The browser integration suite's `js-module.test.ts` runs that JavaScript module on both runtime builds in Chromium and
Firefox: keys on each of its engines, a setting changed by the page, a property activated, a fault (the host's `CRASHED`
state, and a `Crashed` record with reason `FAULT` naming the throw), a handler that never returns (the request stays
unanswered, with no crash and nothing in the ring), and a WebAssembly module in a Worker of its own serving alongside
it, still serving once the JavaScript module has crashed. The page turns the crash and the silence into `EngineCrashed`
and `EngineHung`; that is the core package's ([core.md](core.md)), and `checks.core-browser` runs the silence through
the page's hang detector to `EngineHung` and a restart.

Worker-host integration suites run production transport behavior on asserting and released runtimes, under Node and
Chromium/Firefox. They cover ordered `replyOutSeq`, doorbells, abandonment, fragment/padding boundaries, wraparound,
full-ring waits without pumping, partial-read wake races and crash reporting. `fullRingAppend` has the test side append
a record on the host's thread during a full-ring wait, as a proxied call can: the reply's `replyOutSeq` names the
request's own commit, and the appended record arrives after the reply with the next `seq`. The abandoned-reply case
orders itself by the test build's `replied` instrument, which counts published replies in a shared buffer beside the
`reqMode` the host read for the last, so the page abandons only once the host has read `SYNC` and the test can assert no
doorbell follows. Node unit tests drive `drainOutput` against a fake runtime: a full-ring drain resumes the same copied
record and consumes the runtime's output only once it is published.

Archive checks include native Brotli where supported and forced/automatic fallback; the test build posts a
`brotli-decoder` message naming the decoder each archive went through, and the install scenarios assert it against the
page's own feature test. Pinned Chromium uses fallback; construction of `DecompressionStream("brotli")` is the
production feature test. Node unit tests of the decoder check that undecodable bytes fail with the `Content-Encoding`
hint, natively and through the fallback, while a body that fails mid-stream (a network error, an abort) passes its own
error through. `store-links-memory` and `store-links-stored` install the echo engine's data, which holds a file with two
names, relative and absolute links to a file and a directory, within its store path and into others of the closure, and
a store path that is a single file, and read each path back as the store has it, on memory storage and on storage that
outlives the host. Generated `PROTOCOL.md` includes the SAB layout.

`tools-engine-manifest` runs the build tools' Vitest suites: `symlinks.ts`, which accepts links that resolve inside a
closure (relative, absolute, chained, or a store path that is itself a link) and refuses a dangling link, one leading
out of the closure, a chain that passes outside on its way back in, a link to a directory that only holds closure paths,
and a loop, failing the command with the link named; and `protocol.ts`, which prints the protocol version and checks a
manifest with the protocol's decoder and the runtime's memory bounds.

`hangul-host` uses a real Node Worker, the built Hangul manifest and the test Page: 20 cases across both builds. It
checks output ordering and real engine behavior and fails on warning/error/critical logs. Reserved test operations
measure the heap's peak from its base (`heapPeak`, checked against the declared `heapBytes`), retained pool Worker and
checked-out pthread peaks; `heapBytes` comes from build metadata. These workload results guard declarations without
establishing universal resource bounds. The 16-case C golden harness (17 reported tests including completion) and native
differential traces remain independent checks. Browser host checks exercise the transport, not a live page router or
panel.

`table-host` runs the table module's distribution the same way: 14 cases across both builds, with both engines in one
Worker, a page-relative click on the second page, FocusOut and Reset emitting nothing, the LaTeX table's load time, and
a distribution with a malformed table, whose `CreateEngine` must fail with the native parser's message.

Install-lock liveness tests distinguish a slow installer announcing progress from a silent holder. In "a wait for the
install lock outlives the lock limit while the installer's word keeps arriving" the installer announces every 50 ms and
holds its first piece behind a gate for twice the waiter's 500 ms lock limit, so the waiter must keep waiting on
progress alone, and then finds the data present; in "a wait for the install lock fails once the installer's word stops"
the holder is silent, and the waiter fails its start after the limit. A Node unit test (`install-lifetime.test.ts`)
checks that progress is announced through the clear, the mount, the fetch, the marker and the seal, and that the lock
and the timer are released together.

`test/node/saturate.ts` is a manual load tool, not a check: it starts one CPU-bound Worker per available CPU and runs a
command repeatedly beneath them, printing each run's exit code and time as a JSON line, and stops after 30 minutes or on
an interrupt, killing the command's whole process group. From `packages/worker-host`, in the dev shell and with a
check's manifest in the environment (`IBUS_WEB_WORKER_HOST_TESTS`, from the check's `passthru.manifest`):

```sh
node test/node/saturate.ts 50 pnpm exec vitest run --configLoader native \
  test/node/scenarios.test.ts -t 'outlives the lock limit'
```

Its results are observations under one load, not a timer deadline under arbitrary starvation.

## Page core and demo

`checks.core-node` runs deterministic Node tests for translation, connection budgets, key ownership, mixed
sync/async/manual modes, context policy and recovery. `checks.core-browser` exercises real Worker/runtime/Hangul
integration in Chromium and Firefox, and the page's handling of a JavaScript module against the real host: preloading
fetches its script into the HTTP cache and leaves Cache Storage and the install-only Worker alone, `usage()`, `export()`
and `reset()` touch no database, and a handler that never returns ends in `EngineHung` and a restart. Its synthetic DOM
events use a helper that simulates unprevented native defaults; this does not prove trusted input, native undo, OS
keyboard/layout, Safari or minimum browser versions.

`packages.demo` builds examples/demo, the pinyin-tones JavaScript module with it; `checks.example-demo-smoke` separately
loads that built page in fresh Chromium, checks isolation and opaque archive delivery, and verifies typing and blur
commit with constructed keys. The production demo uses the facade, panel and metadata-driven settings form.

These are default gates. `nix flake check` runs the default milestone tier; the explicit worker-host integration outputs
and `integration-checks` aggregate above remain extended work, not a matrix to repeat for every focused change.

### Production Playwright integration

`nix build .#playwright-integration` serves the production demo through its Vite preview configuration with COOP/COEP
and runs 49 trusted-input tests in each of Chromium, Firefox and WebKit (147 total): Hangul's ten, the table module's
seven, Mozc's five, m17n's seven, Rime's nine, the pinyin-tones module's six and the layout matrix's five. The specs are
grouped by module, in `examples/demo/test/e2e/<module>.spec.ts` with their helpers beside them. Hangul's spec covers
real composition, visible preedit without value/input leakage, focused native undo, separate blur commit, Hanja
paging/click/digit selection, password exclusion, actual Worker restart, native Space reset ordering, 3f settings
changes across live contexts, tabs and reload, and the picker with its Ctrl+Space toggle, which leaves plain input while
deselected. It also opens the page as `/?properties=page` and turns Hangul input on with the page's own switch, the
panel's properties not placed. The table spec (`table.spec.ts`) types `\alpha`, `\to,` and `S@`, keeps one Worker across
engine switches, gives plain input once deselected, checks that its engines stay in one picker group, and checks that
the settings form follows the module. The m17n spec (`m17n.spec.ts`) checks the picker's language groups, types Hindi,
Vietnamese and a Thai tone mark on the field's own consonant, checks that the settings form holds only the selected
engine's instance, shows a variable saved in the form reaching the field once the field has lost focus after the save
and regained it, and times a restart from IndexedDB once the page shows persistent storage. The Rime spec
(`rime.spec.ts`) checks the picker's language groups, installs `rime_ice`'s dictionaries on its first selection and
nothing on its second, timing it, fetches `luna_pinyin` ahead of time into the page's cache and types with it, installs
`cangjie5` ahead of time and finds nothing to install once it is selected, converts a phrase, types Cangjie, turns
`luna_pinyin`'s simplification on with the page's own switch, finds a chosen candidate first after a reload, and checks
that the settings form holds the selected engine's switches and that the page size reaches the panel; each test takes up
to 300 s, and the run's limit is 1800 s. The pinyin-tones spec (`pinyin-tones.spec.ts`), for the JavaScript module the
page imports with `?ibus-module`, checks its picker group, types `ni3 hao3` into `nǐ hǎo`, turns `v-as-u` off with the
page's own switch so that `lv4` stays as typed while `u:` still gives `ü`, checks that the settings form shows the
setting and follows the switch, gives plain input once deselected, and keeps one Worker across selections.

The layout matrix (`layouts.spec.ts`) types into Hangul, Rime's `luna_pinyin`, Mozc, m17n's Vietnamese telex and the
table module's LaTeX from the US, AZERTY, QWERTZ, Dvorak and Colemak layouts, one test per module walking every layout:
a word typed as the engine reads the layout (by place for a US-layout engine, by character otherwise), Meta+A composing
and typing nothing, Ctrl+A selecting all, a dead key in the middle of a word leaving its composition alone, an AltGr
`@`, and, for Rime, the `layout` setting at `default` taking the characters the keys show. Playwright's keyboard knows
only the US layout, so `layouts.ts` registers each layout's key descriptions with Playwright's server half, which runs
in the test process: the browsers' own automation input (CDP, Juggler, WebKit's inspector protocol) then delivers
trusted events with the layout's `key`, `code` and `keyCode`. Only Firefox's automation can hold AltGraph, through a
pressed AltGraph key; Chromium's and WebKit's carry only Shift, Control, Alt and Meta, so the AltGr check runs in
Firefox, and elsewhere an AltGr character (LaTeX's backslash on AZERTY and QWERTZ) arrives unmodified. A dead key is its
`Dead` keydown alone, since no system input method composes under automation. It fails on page errors or visible demo
errors. The target belongs to `ibusWeb.testing.extendedChecks.playwright` and the explicit `integration-checks`
aggregate, outside default `nix flake check`.

Pinned Playwright 1.63.0 runs Linux WebKit 26.6 (revision 2359) in the Nix sandbox using pinned Mesa 26.2.3 software EGL
and an Ubuntu 24.04 Playwright platform override. No CI browser fallback is needed. This is Linux WebKit evidence, not
Safari 17.4 or macOS verification. Linux native undo uses Control+Z; macOS uses Meta+Z. Focused native undo and an
unfocused blur commit are distinct assertions; the latter can use `setRangeText` without native undo. CI also builds
`packages.aarch64-darwin.playwright-integration`, the same suite on macOS, whose WebKit is closer to Safari's.

### Safari and WebDriver

Playwright drives its own WebKit, never Safari, so `examples/demo/test/webdriver/smoke.ts` drives the production demo
through plain W3C WebDriver (`webdriver.ts`, a few commands over `fetch`). It serves the page, starts the driver named
by `IBUS_WEB_WEBDRIVER` with `--port`, opens one session with the capabilities in `IBUS_WEB_WEBDRIVER_CAPABILITIES`, and
checks, as a user's keystrokes through WebDriver's key actions: that the page is cross-origin isolated; Hangul composing
`한` from `gks` and committing it on blur; `rime_ice`'s dictionaries installing and `nihao ` typing `你好`; a candidate
chosen below the first coming first after a reload, which is the IndexedDB backend in the module's Workers at work, with
no read-only or failed-storage report; and no page error. It runs as one session because safaridriver serves one at a
time. Space is pressed by WebDriver's key code, never typed as `" "`, which Safari doesn't type as the Space key and
turns into a dead key under Shift. Each command gives up after two minutes, so a driver that never answers fails the
suite.

- `nix run .#safari-smoke` (aarch64-darwin) runs it on Safari through `/usr/bin/safaridriver`, which must be enabled
  once with `sudo safaridriver --enable`. CI's `safari` job does both on the macOS runner.
- `nix build .#webdriver-smoke` (Linux) runs it on Firefox through geckodriver in the Nix sandbox, so the suite is known
  to work, and keeps working, without a Mac. It is `ibusWeb.testing.extendedChecks.webdriver-smoke`, in
  `integration-checks`.

### Keystroke measurements

`nix run .#keystroke-bench` runs a separate production-preview browser benchmark. One isolated repaired cohort on Ryzen
9 9950X3D (32 logical CPUs), Linux 6.18.54-xanmod1, Node 24.21.0, Playwright 1.63.0 and Vite 8.3.2 used 70 validated
sequential warmup keys, then 500 sequential trusted keys per browser. Each sample starts at keydown capture before the
router and ends when value, selection or preedit application is observed. The observer endpoint includes
snapshot/observer/microtask overhead and possible reset FIFO delay; it excludes paint, keyboard hardware and Playwright
inter-key waiting. Retain-on-failure tracing and normal desktop activity may affect scheduling. These results measured
commit `a174a749`; later reset lifecycle fixes through `8026169` retained the focused-ready dispatch branch but were not
timed again, so no exact current-source latency distribution is claimed.

| Browser                | p50 ms | p99 ms | max ms |
| ---------------------- | -----: | -----: | -----: |
| Chromium 153.0.8010.12 |  0.805 | 15.115 | 21.105 |
| Firefox 155.0          |  1.380 |  2.480 |  2.940 |
| Linux WebKit 26.6      |  2.180 |  4.140 |  4.900 |

Chromium's 72 later-observer endpoints among 500 samples are not all identified as transport abandonment. This browser
metric is separate from the Node protocol framed-record-to-visible-page measurement in
[protocol.md](protocol.md#lookup-decode-measurement).

The same benchmark has a `rime_ice` case: `nihao ` typed round and round, 72 warm-up keys, then 500 measured, each
round's Space committing `你好`, with Rime's dictionaries already installed by the case's first selection. One run on an
AMD Ryzen 9 9950X3D 16-Core Processor (32 logical CPUs), Linux 6.18.55-xanmod1, Node 26.10.0, measuring commit
`78d59488`, with no later-observer endpoints in any browser:

| Browser                | p50 ms | p99 ms | max ms |
| ---------------------- | -----: | -----: | -----: |
| Chromium 153.0.8010.12 |  1.620 |  3.245 |  3.865 |
| Firefox 155.0          |  2.620 |  6.100 |  7.680 |
| Linux WebKit 26.6      |  5.640 |  8.280 | 10.020 |

Rime writes its learning once input pauses ([rime.md](rime.md#learning)). Written during the key after each commit, as
Rime does on its own (commit `fd77db53`, run beside it), that key's write waits in WebKit for the page's main thread,
which spins on the key: WebKit's p99 is 54.1 ms and max 56.0 ms, with 84 later-observer endpoints, one per round.

Each case logs `engine` with its figures; `nix run .#keystroke-bench -- -g rime_ice` runs one case.

### Bundle boundary

`checks.tools-bundle-scan` is a default gate. It fully bundles all seven published page entries (`ibus-web`, its
`effect`/`panel`/`worker` subpaths and the core, panel and protocol packages) plus the production demo. It captures
Vite's executable module graph and emitted imports, checks dependency completeness and scans code/module identities for
Worker host, runtime, Brotli WASM and Emscripten implementation markers. Its negative test really inlines host code and
requires rejection. Named shared transport ABI modules are allowed; a separately deployed Worker/relay/Brotli script
reached as a URL asset is not executable page code. The published facade's `workerUrl` still requires the complete host
asset directory at deployment. See [ibus-web.md](ibus-web.md) for serving requirements.
