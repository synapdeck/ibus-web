# Tooling

The repository's tools all come from the flake: the dev shell for day-to-day work, hk for every
formatter and lint check (run by the git hook, by `nix fmt` and by `checks.hk` alike), the pnpm
workspace for TypeScript, language servers for editors and Claude Code, and CI written in Nix.

## The dev shell

`nix develop` enters it; with direnv, `.envrc` (`use flake`) enters it on `cd`. `.envrc` also
watches every tracked `*.nix` and `*.patch` file, which direnv's `use flake` doesn't see and any
of which can feed the generated editor configuration, so editing a patch or a module reloads the
shell.

What it provides:

- **The WASM toolchain** ([toolchain.md](toolchain.md)): Emscripten with its patches, pkgsWasm's
  wrapped compiler, binutils and `pkg-config` under their target-prefixed names, `meson`,
  `ninja`, and `meson-setup-wasm` (`meson setup` with pkgsWasm's cross files). `PKG_CONFIG_PATH`
  covers the registered dev libraries and their propagated inputs. `EM_CACHE` is `.emcache` in
  the checkout, a writable copy seeded from the frozen cache the first time the shell starts.
- **TypeScript:** Node 24, nixpkgs' pnpm, and the workspace's `tsc`.
- **hk and the tools its steps run:** `hk`, `pkl`, `oxfmt`, `oxlint`, `nixfmt`, `clang-format`
  (from Emscripten's LLVM, so it agrees with clangd), `shfmt`, `reuse`, `actionlint`.
- **Language servers:** `clangd`, `typescript-language-server`, `nixd`, `pkl-lsp`
  ([editor tooling](#editor-tooling)).
- **`write-files`**, which writes the generated files: the CI workflow ([CI](#ci)),
  `pnpm-workspace.yaml` ([the pnpm workspace](#the-pnpm-workspace)), and libibus-web's
  `protocol.h` and `packages/protocol/PROTOCOL.md`, generated from the protocol's schemas
  ([protocol.md](protocol.md#generated-artifacts)).

Its startup builds and links, as git-ignored out-links that also root the store paths against
garbage collection:

| Link                                          | What                                                         |
| --------------------------------------------- | ------------------------------------------------------------ |
| `.hk`                                         | hk's pkl package (`packages.hk-pkl`), then runs `hk install` |
| `.clangd`                                     | the editor's C/C++ configuration (`packages.clangd-config`)  |
| `runtime/wasmfs-idb/src/emscripten-types`     | types for the IndexedDB backend's JavaScript library         |
| `modules/testing/gtest-main/emscripten-types` | types for the GoogleTest harness's JavaScript library        |

Each is built when the shell starts rather than as part of the shell, so the shell still enters
when one doesn't build; a link that fails to build is removed rather than left pointing at an old
build, and the shell says so on stderr.

## hk

hk 2 (`hk.pkl`) defines every formatter and lint check once, as `linters` shared by three hooks:

- `pre-commit` — fixes the staged files (`fix = true`) and stashes unstaged changes with git
  while it runs (`stash = "git"`).
- `check` — checks without changing anything.
- `fix` — fixes everything it can.

The steps:

| Step               | Files                                                                 | Tool                                              |
| ------------------ | --------------------------------------------------------------------- | ------------------------------------------------- |
| `nixfmt`           | `*.nix`                                                               | nixfmt                                            |
| `clang-format`     | C, C++                                                                | clang-format, `.clang-format` (LLVM style)        |
| `shfmt`            | `*.sh`                                                                | shfmt, two-space indent from `.editorconfig`      |
| `oxfmt`            | TS, JS, JSON/JSONC, YAML, Markdown, HTML, TOML (not `pnpm-lock.yaml`) | oxfmt, `.oxfmtrc.jsonc`                           |
| `pkl-format`       | `*.pkl`                                                               | pkl                                               |
| `oxlint`           | TS, JS                                                                | oxlint, `.oxlintrc.jsonc`                         |
| `tsc`              | every directory with a `tsconfig.json`                                | `tsc --noEmit -p` with the workspace's TypeScript |
| `tsconfig-extends` | `**/tsconfig*.json`                                                   | `node modules/flake/tsconfig-extends.ts`          |
| `reuse`            | the whole tree, every run                                             | `reuse lint`                                      |
| `actionlint`       | `.github/workflows/*.yml`                                             | actionlint                                        |

- `tsc` runs once per directory holding a `tsconfig.json` (`workspace_indicator`), so a new
  config is checked without editing `hk.pkl`. A changed JavaScript file or config re-runs it.
  `runtime/wasmfs-idb/tests/library-types/` is excluded: it is a negative type test whose failure
  `checks.wasmfs-idb-types` asserts.
- Two type checks read types Nix generates (the dev shell's `emscripten-types` links). In a hook
  run where a link isn't built, `tsc` skips that directory with
  `tsc: skipped <dir>: <link> isn't built; enter the dev shell to build it`. `checks.hk` sets
  `HK_REQUIRE_NIX_INPUTS=1`, so there it never skips.
- `tsconfig-extends` reads every `tsconfig*.json` git tracks (as JSONC, with `jsonc-parser`) and
  fails unless each reaches the root `tsconfig.base.json` through relative `extends`. It always
  checks the whole set, since a change to one config can break another's chain.

### The hook and committing

The dev shell runs `hk install` on every start (it is idempotent). With git ≥ 2.54 that installs a
config-based hook (`hook.hk-pre-commit.command` in `.git/config`), which runs
`hk run pre-commit --from-hook` unless `HK=0`. The hook needs `hk` and its tools on `PATH`: commit
from a direnv shell, or with `nix develop -c git commit …`. Outside the dev shell a commit fails.

### `nix fmt`

The flake's `formatter` runs `hk fix --all` from the repository root; `nix fmt -- <paths>` runs
`hk fix` on just those paths (resolved against where `nix fmt` ran). It re-points `.hk` first if
the link is stale, so it works outside the dev shell too.

Day-to-day hk commands in the dev shell: `hk check --all`, `hk fix --all`, `hk check -S <step>`
for one step.

### `checks.hk`

`checks.hk` runs the same steps in the Nix sandbox over the flake source, so CI enforces what the
hook enforces:

1. Copies the flake source (exactly the git-tracked files), `git init`s it and `git add`s
   everything, since hk selects files through git.
2. Links, after `git add` so they stay untracked as in a checkout: `.hk`, both generated types
   directories, and every `node_modules` from the Nix workspace build.
3. Sets `HOME`, `HK_STATE_DIR` and `HK_CACHE_DIR` under `$TMPDIR`, `HK_PKL_OFFLINE=1`, and
   `SSL_CERT_FILE` (hk's pkl evaluator builds an HTTP client even offline and fails without a CA
   bundle).
4. Runs `hk check --all --no-fail-fast --no-progress`, so one run reports every failing step.

A type error in a workspace package fails `checks.hk` one step earlier, in the workspace build it
takes `node_modules` from, which compiles the same configs.

### Why `.hk`

`hk.pkl` starts with `amends ".hk/pkl/Config.pkl"` and `import ".hk/pkl/Builtins.pkl"`, a local
copy of hk's pkl package, rather than the `package://` URL hk documents: that form needs the
network, which the sandbox doesn't have, and nixpkgs' hk embeds no copy (hk's build embeds one
only if `Builtins.pkl` has been generated, and nixpkgs doesn't generate it). `packages.hk-pkl`
runs hk's own `scripts/gen_builtins.py` over `pkgs.hk.src` and fails if the source's
`Cargo.toml` version differs from `pkgs.hk.version`, so the package always describes the hk that
evaluates it.

hk 2 evaluates pkl itself and leaves `\(…)` interpolation unexpanded inside multi-line `"""`
strings, which is why the `tsc` step's command is built by concatenation.

### Adding a step

Add the step to `linters` in `hk.pkl`, and its tool to `tools` in `modules/flake/hk.nix`, which
puts it in the dev shell, in `checks.hk` and in the formatter. For a tool hk has a builtin for,
say shellcheck:

```pkl
// hk.pkl, inside `local linters = new Mapping<String, Step> { … }`
["shellcheck"] = Builtins.shellcheck
```

```nix
# modules/flake/hk.nix
tools = [
  hk
  # …
  pkgs.shellcheck
];
```

A builtin's fields can be amended in place (`(Builtins.oxfmt) { exclude = "pnpm-lock.yaml" }`).
A custom step names its files and command; `effect = "read"` says it changes nothing:

```pkl
["reuse"] {
  check = new CommandSpec {
    command = "reuse lint"
    effect = "read"
  }
}
```

Then run `hk check --all` in the shell, and `nix build .#checks.x86_64-linux.hk -L`.

## Formatters and linters

- **oxfmt** formats TypeScript, JavaScript, JSON and JSONC, YAML, Markdown, HTML and TOML at 120
  columns, two-space indent (`.oxfmtrc.jsonc`). It leaves `pnpm-lock.yaml` alone, since pnpm
  rewrites it in its own style on every install, nor the files Nix generates (the workflow, which
  actionlint checks, and `pnpm-workspace.yaml`).
- **oxlint** (`.oxlintrc.jsonc`) runs the `typescript`, `unicorn` and `oxc` plugins with the
  `correctness` category as errors, plus `no-var`, `prefer-const` and `eqeqeq`. Nothing is turned
  off for a file or the repository; the few findings that are deliberate are allowed in place with
  `// oxlint-disable-next-line <rule> -- <why>` (an EM_ASM caller oxlint can't see, a `let` that
  only carries a JSDoc type).
- Both configs are JSONC with a `$schema` and an SPDX header; oxlint finds its `.jsonc` name
  without `-c`. hk's `oxfmt` step names `-c .oxfmtrc.jsonc`, since oxfmt run where it finds no
  config formats with its own defaults, silently, and a named one it can't find fails the step.
- **clang-format** is the LLVM from Emscripten's toolchain, LLVM style (`.clang-format`).
  clang-format mangles JavaScript inside `EM_ASM` bodies (`!==` becomes `!= =`); test fixtures
  that need JavaScript use `EM_JS` between `// clang-format off` and `on`.
- **nixfmt**, **shfmt** (two spaces, from `.editorconfig`), **pkl format**, **actionlint**.

## REUSE

Licensing is metadata, following the REUSE specification: licence texts in `LICENSES/`, an SPDX
header on every file that can hold a comment, and `REUSE.toml` annotations by path for the rest.
`reuse lint` (hk's `reuse` step) fails on any file without both.

- New files carry `SPDX-FileCopyrightText: 2026 Synapdeck, Inc.` and
  `SPDX-License-Identifier: MIT OR Apache-2.0` (libibus-web: `LGPL-2.1-or-later`), in the file's
  comment syntax, first lines after any shebang. Never derive the holder from the git identity.
- `REUSE.toml` annotates what can't hold a comment: `docs/**` and READMEs (with
  `precedence = "override"`, since the docs quote SPDX tags in prose), `package.json` files
  (strict JSON), the lockfiles (`CC0-1.0`), the GLib and Emscripten patch series (their upstreams'
  licences and authors), the generated workflow and `pnpm-workspace.yaml`, and Claude Code's JSON
  manifests.
- There is no catch-all annotation: an unannotated new file must fail the lint.

## TypeScript

All JavaScript that Emscripten doesn't read itself is TypeScript. Scripts the Nix builds run use
Node's type stripping (`node file.ts`), so they keep to erasable syntax: `.ts` import extensions,
no enums, namespaces or parameter properties. No `node -e` or `python -c` scripts are inlined in
Nix.

TypeScript is version 7 (the native compiler). Configuration:

- **`tsconfig.base.json`** at the root holds the standard options: `strict`, `erasableSyntaxOnly`,
  `verbatimModuleSyntax`, `rewriteRelativeImportExtensions`, `module`/`moduleResolution`
  `nodenext`, `target` `es2023`. Every `tsconfig*.json` extends it, directly or through a
  package's own base, and overrides only what its files need: the environment's `lib`/`types`,
  `rootDir`/`outDir`, or `allowJs`/`checkJs`. hk's `tsconfig-extends` step enforces the chain.
- **`tsconfig.node-scripts.json`** extends it for the Nix builds' Node scripts (`noEmit`,
  `allowImportingTsExtensions`, `lib: ["es2023"]`, Node types, and `types/webassembly`, the part
  of the WebAssembly API Node code here uses, which TypeScript declares only in its web libraries);
  each directory of scripts has a `tsconfig.json` extending that. A config for Node code that
  extends a package's base instead names `types/` as a type root itself; `types/tsconfig.json`
  checks the declarations on their own.
- **One `tsconfig.json` per environment directory** in a package (`src/shared`, `src/worker`,
  `src/node`, `src/browser`, and the test directories likewise), each with its own `lib` and
  `types`, so code meant for a Worker can't use Node's API by accident. Packages' `build` scripts
  emit `dist/` (`@ibus-web/test-programs` with `tsc -p` per environment, `@ibus-web/worker-host`
  with tsdown), and checks run the emitted `dist/`; test files run from source through Vitest
  ([testing.md](testing.md#vitest)).
- **JavaScript Emscripten reads** (`--js-library`, `--pre-js`, `--post-js`: the IndexedDB
  backend's library and its test libraries, the GoogleTest harness's report library,
  `host-memory.js`, `size-pre.js`) stays JavaScript, with JSDoc types, checked under a
  `tsconfig.json` extending **`tsconfig.emscripten-js.json`** (`allowJs`/`checkJs`,
  `module: preserve`, a Worker's `es2023` library at the base's target; `size-pre.js`, which runs
  under Node, takes Node's instead), with declarations for what it uses
  from Emscripten: generated from a link of the library (`--emit-tsd`) where one exists, local
  `pre-js.d.ts` declarations otherwise. A library's `__deps` are checked against what it uses by
  `runtime/wasmfs-idb/library-deps.ts`, which parses with the same acorn version Emscripten
  ships (`checks.wasmfs-idb-acorn`). [storage.md](storage.md) describes the backend's library.

Hand-written TypeScript and JavaScript use modern syntax: what is Baseline "Widely available" and
also runs on the oldest supported Node.

## The pnpm workspace

One pnpm workspace at the root (`pnpm-workspace.yaml`): `packages/*` (`@ibus-web/test-programs`,
`@ibus-web/worker-host`, `@ibus-web/protocol`), `runtime/wasmfs-idb` (the library checker's acorn), and
`modules/glib/checks/tests` (the GLib gate's TOML reader).

`pnpm-workspace.yaml` is generated: its package globs and catalog are declared in Nix
(`pnpmWorkspace` in `modules/typescript/default.nix`), which reads them for its own builds, and
`nix run .#write-files` writes the file; `checks."files:pnpm-workspace.yaml"` fails while the
tracked copy differs. The Nix builds install from the generated file, not the tracked copy. Never edit the YAML: change the Nix, run `write-files`, then `pnpm install`.

- **Versions.** Manifests use ordinary caret ranges; `pnpm-lock.yaml` pins exact versions.
- **The catalog.** Whatever must be one version across the repository — TypeScript, Vitest and its
  browser packages, Playwright, Effect, `@effect/vitest`, `@types/node`, and the shared tools
  (`tsdown`, `jsonc-parser`, `smol-toml`) — is declared once in the workspace's catalog. Packages
  name these as `catalog:`, never with a version.
  Repository-wide tools are `devDependencies` of the root `package.json`; a package that needs
  one in its own manifest (a peer dependency, a package-level script) names it `catalog:` too.
- **Versions pnpm can't know** are asserted against nixpkgs when Nix installs the workspace:
  - `playwright` is exactly nixpkgs' `playwright-driver` version (the catalog takes it from
    `playwright-driver` itself, without a caret), since each Playwright release drives specific
    browser builds and the browsers come from nixpkgs. Every package depending on `playwright` or
    `@vitest/browser-playwright` is checked (`modules/typescript/assert-dependency.ts`); a
    nixpkgs update that moves the driver fails the generated file's check until `write-files` and
    `pnpm install` follow it.
  - `packageManager` in the root `package.json` names nixpkgs' pnpm: pnpm compares itself with it
    and, offline, can't fetch another.
  - acorn in `runtime/wasmfs-idb` is the version Emscripten ships.
- **pnpm 12**, nixpkgs' default `pnpm`, with its defaults. Its lockfile is two YAML documents (the
  first records pnpm itself), which nixpkgs' fetcher handles. No dependency build script is
  allowed or needed.
- **Effect** is a peer dependency of every package that uses it, `catalog:` (`^4.0.0`).

### In Nix

`modules/typescript/default.nix` builds the workspace in three stages, so that editing a source
refetches nothing:

1. `pnpmDeps` (`fetchPnpmDeps`) — the dependencies, from the manifests and lockfile only. Its hash
   changes when the lockfile does: update `hash` from the mismatch error.
2. `ibusWeb.typescript.nodeModules` — every `node_modules` (root and per package) installed
   offline from the manifests. The Playwright assertion runs here. Builds that run a script with
   its package's dependencies but shouldn't rebuild on every source edit use it
   (`packageNodeModules ./dir`), as the GLib gate does, and the library checker
   (`ibusWeb.runtime.libraryDeps`: `library-deps.ts` beside its package's `node_modules`, which
   the type derivations and checks for both JavaScript libraries run).
3. `ibusWeb.typescript.workspace` — the sources (each package's `.ts`, `.mts`, `.cts`, `.json`,
   plus files listed under `ibusWeb.assets` in its `package.json`) with `nodeModules` laid over
   them, compiled with `pnpm -r run build`. Checks run from this output.

`ibusWeb.typescript.tsc` is the workspace's single TypeScript (the build fails if the lockfile
resolves more than one), used by hk, the dev shell and the type-check derivations.

### tsdown

`@ibus-web/worker-host` bundles with tsdown. Each Worker script (`dist/worker/index.js`, the relay)
is one self-contained module with Effect bundled in and no chunk shared with another: a Worker
loads by URL as it is on disk, so it can't resolve a bare import, and a page's bundler copies a
script found by `new URL(…, import.meta.url)` without the chunks it imports. `dist/shared/` keeps
`effect` external, as the peer dependency. Declarations come from tsdown's oxc generator
(`isolatedDeclarations`), since TypeScript 7 has no compiler API. `tsc --noEmit` remains the type
check. Details in [worker-host.md](worker-host.md).

`@ibus-web/protocol` bundles one entry, `dist/index.js`, with `effect` external. Its declarations
come from tsdown's `tsgo` generator instead: oxc's isolated declarations can't express a class
that extends an expression, as every `Schema.TaggedClass` message does (TS9021).

## Editor tooling

- **clangd** is the LLVM Emscripten drives, so its builtin headers match, wrapped with
  `--query-driver` trusting pkgsWasm's compiler. `.clangd` is `packages.clangd-config`, built
  from the flake, giving loose sources (those without a compilation database) the cross
  compiler, the common flags, an explicit `-resource-dir`, the dev libraries' include paths, and
  per-path flags from `ibusWeb.toolchain.clangdPathFlags` (GoogleTest's headers for tests, a
  test's `-D`s). The dev shell rebuilds the link on entry, so it follows the flake;
  `checks.clangd` runs `clangd --check` on every C and C++ source in the repository, so the
  configuration can't drift from the build. A module that adds sources needing extra flags adds a
  `clangdPathFlags` entry beside them; `.envrc` already watches every module.
- **Claude Code** gets language servers through plugins, enabled in `.claude/settings.json`:
  `clangd-lsp` and `typescript-lsp` from the official marketplace, and `nixd-lsp` and `pkl-lsp`
  from the repository's own marketplace (`.claude-plugin/marketplace.json`, plugins under
  `tools/claude/`). The plugins only name commands; the servers come from the dev shell. **Start
  Claude Code inside the dev shell** (a direnv shell, or `nix develop -c claude`), or the servers
  won't resolve. The shell's greeting says so.
- **TypeScript's server.** The official plugin runs `typescript-language-server --stdio`, which
  speaks to tsserver; TypeScript 7 ships no tsserver, and its compiler serves LSP itself. The dev
  shell's `typescript-language-server` is a shim that execs the workspace's `tsc --lsp --stdio`,
  so the editor and `tsc` are always the same version. It ignores every flag but `--stdio` and
  offers only what TypeScript 7's LSP does.
- **nixd** and **pkl-lsp** from nixpkgs serve `.nix` and `.pkl` files.

## Flake inputs

An input comes from FlakeHub (`https://flakehub.com/f/<org>/<project>/<version>`) when the project
publishes there **and** its latest FlakeHub release is current with upstream's default branch;
otherwise from `github:`. Some projects stopped publishing to FlakeHub, so check before switching
(compare the latest release's revision with upstream's head), and take the latest release when
switching. nixpkgs, flake-parts and github-actions-nix come from FlakeHub; import-tree, devshell,
flake-root, systems and files, which have no current FlakeHub entries, from GitHub.

## Flake apps

- **`nix run .#write-files`** writes every generated file ([the dev shell](#the-dev-shell) lists
  them).
- **`nix run .#protocol-bench`** times decoding a framed 500-candidate lookup table from the built
  workspace. It is an app rather than a check, since wall-clock timing on a loaded builder means
  nothing ([protocol.md](protocol.md#lookup-decode-measurement)).

## CI

### Written in Nix

The workflow is Nix (`modules/flake/ci.nix`) through `github-actions-nix`; the `files` flake
module writes it into the tree as `.github/workflows/ci.yml`. Never edit the YAML:

- `nix run .#write-files` (or `write-files` in the dev shell) rewrites every generated file.
- `checks."files:.github/workflows/ci.yml"` fails while the tracked file differs from what the
  Nix generates, so a change to `ci.nix` without `write-files` fails `nix flake check`.
- The writer only writes and checks the files it configures; a workflow removed from the Nix
  must be `git rm`ed by hand.
- The generator writes its own header line, so the workflow's SPDX annotation is in `REUSE.toml`.
- actionlint (in hk) checks the generated file.

### What it does

`ci.yml` runs on pull requests and on pushes to `master`, with `contents: read` and
`id-token: write` (Determinate Nix and FlakeHub Cache authenticate with the job's OIDC token). A
pull request's new push cancels its run in progress (`concurrency`, grouped by pull request);
every push to `master` keeps its own run.

- **`check`** — check out, install Determinate Nix, allow unprivileged user namespaces
  (`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, where the runner has the
  setting: Ubuntu 24.04's AppArmor forbids them, and Chromium's sandbox, which the browser checks
  keep on, needs them), enable
  FlakeHub Cache, then `nix flake check -L --system x86_64-linux`, within 240 minutes. Checks
  are defined for x86_64-linux, aarch64-linux and aarch64-darwin; the hosted runners are
  x86_64-linux, and the other systems' checks need their own machines.
- **`publish`** — `needs: [check]`, and runs only on a push to `master`
  (`if: github.event_name == 'push' && github.ref == 'refs/heads/master'`). It publishes the flake
  to FlakeHub as `synapdeck/ibus-web`, private and rolling (`flakehub-push`), within 30 minutes.
  FlakeHub Cache grants access per published flake, so the cache needs this flake published; only
  a `master` that passed its checks is.

Actions are pinned to release tags: `actions/checkout@v7.0.1`; `determinate-nix-action` and
`flakehub-cache-action` both at one `determinateVersion` (`v3.23.0`), since they release together
and mismatched versions are untested against each other. `flakehub-push` follows its major tag,
`v7`: it is tagged by major version only, so it can't be pinned to a release. To bump one, edit
`ci.nix`, then `nix run .#write-files`.

### The cache

FlakeHub Cache holds what CI builds, so a later run substitutes the patched Emscripten, the cache,
pkgsWasm's packages and the checks instead of building them. Pull requests from forks get no
cache: GitHub's token for a fork's pull request lacks the claims FlakeHub Cache needs, so those
runs build from scratch.

To read the cache on a workstation, install Determinate Nix and run `determinate-nixd login`,
which authenticates it to FlakeHub (access is per flake, granted through the organisation). Then
a build substitutes from `cache.flakehub.com`; `nix build -L .#checks.x86_64-linux.hk` should
show `copying path … from 'https://cache.flakehub.com'`.

### First run

The first runs need checking by hand. Prerequisites: the `synapdeck` organisation has FlakeHub
with a plan covering private flakes and FlakeHub Cache, and the GitHub repository is connected to
it.

1. **Publish.** On the first push to `master`, `check` passes and then `publish` runs (it is
   skipped on pull requests); `synapdeck/ibus-web` appears on FlakeHub as private, at
   `0.1.<commit count>+rev-<sha>`. Until it exists the cache has no flake to attach access
   control to.
2. **The cache receives paths.** The "Use FlakeHub Cache" step's post-job log reports a non-zero
   count of paths pushed.
3. **A second run substitutes.** Re-run, or push a trivial commit: the `nix flake check -L` log
   shows `copying path … from 'https://cache.flakehub.com'` for the heavy derivations (the patched
   Emscripten, the cache and toolchain, pkgsWasm's GLib) rather than `building …`.
4. **Cold-run cost.** Note the first run's wall time against the `check` job's 240-minute limit
   (GitHub's own is six hours), and watch for disk exhaustion on `ubuntu-latest` (about 14 GB
   free): a cold run rebuilds the patched Emscripten and everything WASM.
5. **Chromium's sandbox.** `checks.worker-host-browser` and the browser test-program checks pass
   with Chromium's sandbox on, which shows the user-namespace step took effect; if Chromium fails
   to launch with a sandbox error, that step didn't.
6. **Fork pull requests** still run and pass, without cache, at cold-run cost.
7. **Superseded runs.** A second push to a pull request cancels the first's run; a push to
   `master` doesn't cancel another.
8. **Determinate Nix** logs that `determinate-nixd` authenticated to FlakeHub through OIDC; it
   fails visibly if `id-token: write` is missing.
