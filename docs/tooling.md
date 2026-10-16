# Tooling

The repository's tools all come from the flake: the dev shell for day-to-day work, hk for every formatter and lint check
(run by the git hook, by `nix fmt` and by `checks.flake-hk` alike), the pnpm workspace for TypeScript, language servers
for editors and Claude Code, and CI written in Nix.

## The dev shell

`nix develop` enters it; with direnv, `.envrc` (`use flake`) enters it on `cd`. `.envrc` also watches every tracked
`*.nix` and `*.patch` file, which direnv's `use flake` doesn't see and any of which can feed the generated editor
configuration, so editing a patch or a module reloads the shell.

What it provides:

- **The WASM toolchain** ([toolchain.md](toolchain.md)): Emscripten with its patches, pkgsWasm's wrapped compiler,
  binutils and `pkg-config` under their target-prefixed names, `meson`, `ninja`, and `meson-setup-wasm` (`meson setup`
  with pkgsWasm's cross files). `PKG_CONFIG_PATH` covers the registered dev libraries and their propagated inputs.
  `EM_CACHE` is `.emcache` in the checkout, a writable copy of the frozen cache. The copy records which frozen cache it
  came from, and the shell replaces it on entry once the frozen cache's store path changes, dropping whatever builds in
  the shell added to it (`checks.emscripten-dev-cache`).
- **TypeScript:** Node 26, nixpkgs' pnpm, and the workspace's `tsc`.
- **hk and the tools its steps run:** `hk`, `pkl`, `oxfmt`, `oxlint`, `nixfmt`, `clang-format` (from Emscripten's LLVM,
  so it agrees with clangd), `shfmt`, `reuse`, `actionlint`, `lychee`.
- **Language servers:** `clangd`, `typescript-language-server`, `nixd`, `pkl-lsp` ([editor tooling](#editor-tooling)).
- **`write-files`**, which writes the generated files: the CI workflow ([CI](#ci)), `pnpm-workspace.yaml`
  ([the pnpm workspace](#the-pnpm-workspace)), libibus-web's `protocol.h` and `packages/protocol/PROTOCOL.md`, generated
  from the protocol's schemas ([protocol.md](protocol.md#generated-artifacts)), and the keysym tables in
  `packages/core/src/keys/` (`*.generated.ts`), libibus-web's US keymap table (`us-keymap.generated.h`) and the
  `NOTICES/` and `LICENSES/LicenseRef-xkeyboard-config.txt` texts that accompany their sources. `.generated-files` lists
  them all; the writer deletes a file it listed once the Nix stops generating it.

Its startup builds and links, as git-ignored out-links that also root the store paths against garbage collection:

| Link                                          | What                                                         |
| --------------------------------------------- | ------------------------------------------------------------ |
| `.hk`                                         | hk's pkl package (`packages.hk-pkl`), then runs `hk install` |
| `.clangd`                                     | the editor's C/C++ configuration (`packages.clangd-config`)  |
| `runtime/wasmfs-idb/src/emscripten-types`     | types for the IndexedDB backend's JavaScript library         |
| `modules/testing/gtest-main/emscripten-types` | types for the GoogleTest harness's JavaScript library        |

Each is built when the shell starts rather than as part of the shell, so the shell still enters when one doesn't build;
a link that fails to build is removed rather than left pointing at an old build, and the shell says so on stderr.

## hk

hk 2 (`hk.pkl`) defines every formatter and lint check once, as `linters` shared by three hooks:

- `pre-commit` — fixes the staged files (`fix = true`) and stashes unstaged changes with git while it runs
  (`stash = "git"`).
- `check` — checks without changing anything.
- `fix` — fixes everything it can.

The steps:

| Step               | Files                                                                                                                                      | Tool                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `nixfmt`           | `*.nix`                                                                                                                                    | nixfmt                                            |
| `clang-format`     | C, C++                                                                                                                                     | clang-format, `.clang-format` (LLVM style)        |
| `shfmt`            | `*.sh`                                                                                                                                     | shfmt, two-space indent from `.editorconfig`      |
| `oxfmt`            | TS, JS, JSON/JSONC, YAML, Markdown, HTML, TOML (not `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.github/workflows/*.yml` or `docs/plans/**`) | oxfmt, `.oxfmtrc.jsonc`                           |
| `pkl-format`       | `*.pkl`                                                                                                                                    | pkl                                               |
| `oxlint`           | TS, JS                                                                                                                                     | oxlint, `.oxlintrc.jsonc`                         |
| `tsc`              | every directory with a `tsconfig.json`                                                                                                     | `tsc -b --noEmit` with the workspace's TypeScript |
| `tsconfig-extends` | `**/tsconfig*.json`, `**/package.json`, `packages/tsconfig/*.json`                                                                         | `node tools/tsconfig-extends/tsconfig-extends.ts` |
| `reuse`            | the whole tree, every run                                                                                                                  | `reuse lint`                                      |
| `links`            | every Markdown file git tracks, every run                                                                                                  | lychee, offline, with heading anchors             |
| `actionlint`       | `.github/workflows/*.yml`                                                                                                                  | actionlint                                        |

- `tsc` runs once per directory holding a `tsconfig.json` (`workspace_indicator`), so a new config is checked without
  editing `hk.pkl`. A changed JavaScript file or config re-runs it. It runs in build mode, because a package's
  `tsconfig.json` only references its other configs. `runtime/wasmfs-idb/tests/library-types/` is excluded: it is a
  negative type test whose failure `checks.wasmfs-idb-types` asserts.
- Two type checks read types Nix generates (the dev shell's `emscripten-types` links). In a hook run where a link isn't
  built, `tsc` skips that directory with `tsc: skipped <dir>: <link> isn't built; enter the dev shell to build it`.
  `checks.flake-hk` sets `HK_REQUIRE_NIX_INPUTS=1`, so there it never skips. It also fails unless `hk.pkl`'s `nixInputs`
  and the root `.gitignore` each name exactly the links `ibusWeb.toolchain.emscriptenTypes` makes.
- `tsconfig-extends` reads every `tsconfig*.json` git tracks (as JSONC, with `jsonc-parser`) and fails unless each
  reaches one of `@ibus-web/tsconfig`'s presets through `extends`. It always checks the whole set, since a change to one
  config can break another's chain.

### The hook and committing

The dev shell runs `hk install` on every start (it is idempotent). With git ≥ 2.54 that installs a config-based hook
(`hook.hk-pre-commit.command` in `.git/config`), which runs `hk run pre-commit --from-hook` unless `HK=0`. The hook
needs `hk` and its tools on `PATH`: commit from a direnv shell, or with `nix develop -c git commit …`. Outside the dev
shell a commit fails.

### `nix fmt`

The flake's `formatter` runs `hk fix --all` from the repository root; `nix fmt -- <paths>` runs `hk fix` on just those
paths (resolved against where `nix fmt` ran). It re-points `.hk` first if the link is stale, so it works outside the dev
shell too.

Day-to-day hk commands in the dev shell: `hk check --all`, `hk fix --all`, `hk check -S <step>` for one step.

### `checks.flake-hk`

`checks.flake-hk` runs the same steps in the Nix sandbox over the flake source, so CI enforces what the hook enforces:

1. Copies the flake source (exactly the git-tracked files), `git init`s it and `git add`s everything, since hk selects
   files through git.
2. Links, after `git add` so they stay untracked as in a checkout: `.hk`, both generated types directories, and every
   `node_modules` from the Nix workspace build.
3. Sets `HOME`, `HK_STATE_DIR` and `HK_CACHE_DIR` under `$TMPDIR`, `HK_PKL_OFFLINE=1`, and `SSL_CERT_FILE` (hk's pkl
   evaluator builds an HTTP client even offline and fails without a CA bundle).
4. Runs `hk check --all --no-fail-fast --no-progress`, so one run reports every failing step.

A type error in a workspace package fails `checks.flake-hk` one step earlier, in the workspace build it takes
`node_modules` from, which compiles the same configs.

### Why `.hk`

`hk.pkl` starts with `amends ".hk/pkl/Config.pkl"` and `import ".hk/pkl/Builtins.pkl"`, a local copy of hk's pkl
package, rather than the `package://` URL hk documents: that form needs the network, which the sandbox doesn't have, and
nixpkgs' hk embeds no copy (hk's build embeds one only if `Builtins.pkl` has been generated, and nixpkgs doesn't
generate it). `packages.hk-pkl` runs hk's own `scripts/gen_builtins.py` over `pkgs.hk.src` and fails unless the source's
`Cargo.toml` version is the one `pkgs.hk`'s binary reports, so the package always describes the hk that evaluates it.

hk 2 evaluates pkl itself and leaves `\(…)` interpolation unexpanded inside multi-line `"""` strings, which is why the
`tsc` step's command is built by concatenation.

### Adding a step

Add the step to `linters` in `hk.pkl`, and its tool to `tools` in `modules/flake/hk.nix`, which puts it in the dev
shell, in `checks.flake-hk` and in the formatter. For a tool hk has a builtin for, say shellcheck:

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

A builtin's fields can be amended in place (`(Builtins.oxfmt) { exclude = "pnpm-lock.yaml" }`). A custom step names its
files and command; `effect = "read"` says it changes nothing:

```pkl
["reuse"] {
  check = new CommandSpec {
    command = "reuse lint"
    effect = "read"
  }
}
```

Then run `hk check --all` in the shell, and `nix build .#checks.x86_64-linux.flake-hk -L`.

## Formatters and linters

- **oxfmt** formats TypeScript, JavaScript, JSON and JSONC, YAML, Markdown, HTML and TOML at 120 columns, two-space
  indent (`.oxfmtrc.jsonc`). It leaves `pnpm-lock.yaml` alone, since pnpm rewrites it in its own style on every install,
  nor the files Nix generates (the workflow, which actionlint checks, and `pnpm-workspace.yaml`).
- **oxlint** (`.oxlintrc.jsonc`) runs the `typescript`, `unicorn` and `oxc` plugins with the `correctness` category as
  errors, plus `no-var`, `prefer-const` and `eqeqeq`. Nothing is turned off for a file or the repository; the few
  findings that are deliberate are allowed in place with `// oxlint-disable-next-line <rule> -- <why>` (an EM_ASM caller
  oxlint can't see, a `let` that only carries a JSDoc type).
- Both configs are JSONC with a `$schema` and an SPDX header; oxlint finds its `.jsonc` name without `-c`. hk's `oxfmt`
  step names `-c .oxfmtrc.jsonc`, since oxfmt run where it finds no config formats with its own defaults, silently, and
  a named one it can't find fails the step. hk's evaluator has no list operations, so rather than respelling the
  builtin's three commands, the step's `prefix` is a `sh -c` that inserts the flag after the command name.
- **clang-format** is the LLVM from Emscripten's toolchain, LLVM style (`.clang-format`). clang-format mangles
  JavaScript inside `EM_ASM` bodies (`!==` becomes `!= =`); test fixtures that need JavaScript use `EM_JS` between
  `// clang-format off` and `on`.
- **nixfmt**, **shfmt** (two spaces, from `.editorconfig`), **pkl format**, **actionlint**.

## REUSE

Licensing is metadata, following the REUSE specification: licence texts in `LICENSES/`, an SPDX header on every file
that can hold a comment, and `REUSE.toml` annotations by path for the rest. `reuse lint` (hk's `reuse` step) fails on
any file without both.

- New files carry `SPDX-FileCopyrightText: 2026 Synapdeck, Inc.` and `SPDX-License-Identifier: MIT OR Apache-2.0`
  (libibus-web: `LGPL-2.1-or-later`), in the file's comment syntax, first lines after any shebang. Never derive the
  holder from the git identity.
- `REUSE.toml` annotates what can't hold a comment: `docs/**` and READMEs (with `precedence = "override"`, since the
  docs quote SPDX tags in prose), `package.json` files (strict JSON), the lockfiles (`CC0-1.0`), the GLib and Emscripten
  patch series (their upstreams' licences and authors), the generated workflow and `pnpm-workspace.yaml`, and Claude
  Code's JSON manifests.
- There is no catch-all annotation: an unannotated new file must fail the lint.

## TypeScript

All JavaScript that Emscripten doesn't read itself is TypeScript. Scripts the Nix builds run use Node's type stripping
(`node file.ts`), so they keep to erasable syntax: `.ts` import extensions, no enums, namespaces or parameter
properties. No `node -e` or `python -c` scripts are inlined in Nix.

TypeScript is version 7 (the native compiler). Configuration:

- **`@ibus-web/tsconfig`** (`packages/tsconfig/`, private) holds the presets every tsconfig extends. `base.json` holds
  the standard options: `strict`, `exactOptionalPropertyTypes`, `erasableSyntaxOnly`, `verbatimModuleSyntax`,
  `rewriteRelativeImportExtensions`, `module`/`moduleResolution` `nodenext`, `target` `es2023`. Emit is off, since
  bundlers and Node's type stripping produce the JavaScript; a config that emits turns it back on. The other presets add
  an environment's `lib` and `types`:
  - `dom.json` for page code and browser tests;
  - `worker.json` for code that runs in a dedicated Worker;
  - `node.json` for tools, Node tests and the scripts Nix runs. It also brings in the package's declarations
    (`types/webassembly`) of the part of the WebAssembly API Node code here uses, which TypeScript declares only in its
    web libraries;
  - `emscripten-js.json` for JavaScript that Emscripten bundles as scripts.
- **One tsconfig per configuration, at the package root.** `tsconfig.json` only references the others and is what
  editors open. A target gets a config named for it (`tsconfig.shared.json`, `tsconfig.worker.json`,
  `tsconfig.page.json`, …), and tests get `tsconfig.test.json` and `tsconfig.test-browser.json`; `tsconfig.config.json`
  covers the tsdown and Vitest configs. Each has its own `lib` and `types`, so code meant for a Worker can't use Node's
  API by accident. A package depends on `@ibus-web/tsconfig` and extends a preset by name. hk's `tsconfig-extends` step
  fails unless every tsconfig sits at a package root and extends a preset or another config of its own package; solution
  configs are exempt.
- **Builds.** Packages' `build` scripts emit `dist/`: tsdown for the published packages, `tsc -p` per environment for
  `@ibus-web/test-programs`. Checks run the emitted `dist/`. Test files run from source through Vitest
  ([testing.md](testing.md#vitest)).
- **JavaScript Emscripten reads** (`--js-library`, `--pre-js`, `--post-js`) stays JavaScript, with JSDoc types:
  - the IndexedDB backend's library and its test libraries;
  - the GoogleTest harness's report library;
  - `host-memory.js`;
  - `size-pre.js`.

  It's checked under its component's tsconfig, which extends `@ibus-web/tsconfig/emscripten-js.json`
  (`allowJs`/`checkJs`, `module: preserve`, a Worker's `es2023` library; `size-pre.js`, which runs under Node, takes
  Node's instead). Its declarations for what it uses from Emscripten are generated from a link of the library
  (`--emit-tsd`, through `ibusWeb.lib.emscriptenTypes`) where one exists, and local `.d.ts` files otherwise.
  `tools/emscripten-library-deps` checks a library's `__deps` against what it uses, parsing with the acorn version
  Emscripten ships (`checks.tools-emscripten-library-deps-acorn`). [storage.md](storage.md) describes the backend's
  library.

Hand-written TypeScript and JavaScript use modern syntax: what is Baseline "Widely available" and also runs on the
oldest supported Node.

## The pnpm workspace

One pnpm workspace at the root (`pnpm-workspace.yaml`). Every directory that holds TypeScript is one of its packages,
with a `package.json` naming exactly what that directory imports; the root `package.json` has no dependencies.

| Directory                                                                             | Packages                                                                                                                                                         |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/*`                                                                          | the published `@ibus-web/protocol`, `@ibus-web/worker-host`, `@ibus-web/core`, `@ibus-web/panel` and `ibus-web`; `@ibus-web/test-programs`; `@ibus-web/tsconfig` |
| `packages/engines/*`                                                                  | `@ibus-web/engine-<name>`, whose contents Nix builds; in the workspace so that Changesets versions them ([Releases](#releases))                                  |
| `tools/*`                                                                             | one private package per tool, `@ibus-web/<tool>`                                                                                                                 |
| `engines/m17n/descriptors`                                                            | `@ibus-web/m17n-descriptors`, which turns the m17n descriptor program's output into the module's descriptors, settings paths and variable schemas                |
| `examples/*`                                                                          | `@ibus-web/example-demo`, with its end-to-end tests                                                                                                              |
| `runtime/ibus-runtime`, `runtime/wasmfs-idb`, `modules/emscripten`, `modules/testing` | the JavaScript Emscripten links into those components, and their Vitest suites                                                                                   |

`pnpm-workspace.yaml` is generated: its package globs and catalog are declared in Nix (`pnpmWorkspace` in
`modules/typescript/files.nix`), which reads them for its own builds, and `nix run .#write-files` writes the file;
`checks."files:pnpm-workspace.yaml"` fails while the tracked copy differs. The Nix builds install from the generated
file, not the tracked copy. Never edit the YAML: change the Nix, run `write-files`, then `pnpm install`.

- **Versions.** Manifests use ordinary caret ranges; `pnpm-lock.yaml` pins exact versions.
- **The catalog.** Whatever must be one version across the repository — TypeScript, Vitest and its browser packages,
  Playwright, Effect, `@effect/vitest`, `@types/node`, and the shared tools (`tsdown`, `jsonc-parser`, `smol-toml`) — is
  declared once in the workspace's catalog. Packages name these as `catalog:`, never with a version. A package names
  what it imports itself, as `catalog:` when the catalog has it.
- **Versions pnpm can't know** are asserted against nixpkgs when Nix installs the workspace:
  - `playwright` is exactly nixpkgs' `playwright-driver` version (the catalog takes it from `playwright-driver` itself,
    without a caret), since each Playwright release drives specific browser builds and the browsers come from nixpkgs.
    Every package depending on `playwright` or `@vitest/browser-playwright` is checked
    (`tools/assert-dependency/assert-dependency.ts`); a nixpkgs update that moves the driver fails the generated file's
    check until `write-files` and `pnpm install` follow it.
  - `packageManager` in the root `package.json` names nixpkgs' pnpm: pnpm compares itself with it and, offline, can't
    fetch another.
  - acorn in `tools/emscripten-library-deps` is the version Emscripten ships.
- **pnpm 12**, nixpkgs' default `pnpm`, with its defaults. Its lockfile is two YAML documents (the first records pnpm
  itself), which nixpkgs' fetcher handles. No dependency build script is allowed or needed.
- **Effect** is a peer dependency of every package that uses it, `catalog:` (`^4.0.0`).

### In Nix

`modules/typescript/workspace.nix` builds the workspace in three stages, so that editing a source refetches nothing:

1. `pnpmDeps` (`fetchPnpmDeps`) — the dependencies, from the manifests and lockfile only. Its hash changes when the
   lockfile does: update `hash` from the mismatch error.
2. `ibusWeb.typescript.nodeModules` — every `node_modules` (root and per package) installed offline from the manifests.
   The Playwright assertion runs here. Builds that run a script with its package's dependencies but shouldn't rebuild on
   every source edit use it (`packageNodeModules ./dir`), as the GLib test gate (`tools/glib-test-gate`) and the library
   checker (`tools/emscripten-library-deps`) do.
3. `ibusWeb.typescript.workspace` — the sources (each package's `.ts`, `.mts`, `.cts`, `.json`, plus files listed under
   `ibusWeb.assets` in its `package.json` and repository files outside any package that it reads, listed in
   `ibusWeb.typescript.extraSources`) with `nodeModules` laid over them, compiled with `pnpm -r run build`. Checks run
   from this output. `tools/pack-licenses` reads `REUSE.toml`, `LICENSE-*`, `LICENSES/` and `NOTICES/`, and
   `tools/keysyms` the generated notices, which none of the packages hold.

`ibusWeb.typescript.tsc` is the workspace's single TypeScript (the build fails if the lockfile resolves more than one),
used by hk, the dev shell and the type-check derivations.

### tsdown

Every published package bundles with tsdown and writes sourcemaps, which `tools/pack-licenses` reads
([below](#licenses-in-packed-packages)). `@ibus-web/worker-host`'s are the interesting ones: each Worker script
(`dist/worker/index.js`, the relay) is one self-contained module with Effect bundled in and no chunk shared with
another: a Worker loads by URL as it is on disk, so it can't resolve a bare import, and a page's bundler copies a script
found by `new URL(…, import.meta.url)` without the chunks it imports. `dist/shared/` keeps `effect` external, as the
peer dependency, and its declarations come from tsdown's oxc generator (`isolatedDeclarations`); the Worker scripts'
declarations are checked by `tsc -p tsconfig.types.json` after the build. Details in [worker-host.md](worker-host.md).

`@ibus-web/protocol` bundles one entry, `dist/index.js`, with `effect` external. The other published packages, protocol
among them, take their declarations from tsdown's `tsgo` generator: oxc's isolated declarations can't express a class
that extends an expression, as every `Schema.TaggedClass` message does (TS9021).

### Licenses in packed packages

A published package's tarball carries the license of everything bundled into it. Every published package's tsdown config
writes sourcemaps, and its `prepack` and `postpack` scripts run `tools/pack-licenses`:

- **`prepack`** reads the sources of every sourcemap beside the package's packed scripts.
  - It follows a source that is itself a built script with a map. A bundle of another workspace package's `dist/`
    therefore leads back to that package's sources.
  - It reads a copied directory's maps where they were built. ibus-web's `dist/host/` is declared with
    `ibusWeb.copiedFrom` in its `package.json`.
  - A script that only re-exports other modules has no map, since it has no code of its own; it needs none.
  - For each repository file it finds, it takes the SPDX license REUSE gives it, from the file's header or a
    `REUSE.toml` annotation. If that isn't the repository's own `MIT OR Apache-2.0`, it copies `LICENSES/<id>.txt`.
  - For each file from `node_modules`, it copies that dependency's own license files to `LICENSES/<package>/`.
  - It adds the `NOTICES/` files that the map in `tools/pack-licenses/notices.ts` ties to a bundled file, and always
    adds `LICENSE-MIT` and `LICENSE-APACHE`.
  - It records what it wrote in `.pack-licenses.json`.
- **`postpack`** deletes exactly those files.
- **`check`** (`node tools/pack-licenses/cli.ts check <package>`) prints what `prepack` would copy. It fails on any
  bundled file whose license it can't find, and on any packed script without a sourcemap.
  `checks.tools-pack-licenses-packages` runs it on every published package, so a newly bundled dependency without a
  license file fails CI.

No package keeps a `LICENSES/` directory in the tree; the root `.gitignore` ignores the copies.

### Packing in Nix

`ibusWeb.typescript.npmTarball` packs a package with `pnpm pack`, its lifecycle scripts included, into a derivation that
holds the tarball. It copies a tree (`src`, with the package at `dir` in it) into a writable directory, and copies in
`files`, Nix-built files or directories by their path in the package, before packing. `licenses` names SPDX identifiers
whose texts from the root `LICENSES/` go into the package's `LICENSES/`, for a package whose contents
`tools/pack-licenses` can't trace, such as an engine's WebAssembly. The tarball must contain every file the package's
`exports` names without a wildcard, and whatever `expect` adds, and packing must leave the package directory as it found
it, so `postpack` has to remove all that `prepack` wrote.

Every published package's tarball is in `legacyPackages.<system>.npm`, by the name of its directory, and `npm.all` holds
them all in one directory:

```sh
nix build .#npm.all          # every tarball
nix build .#npm.worker-host  # one
```

The TypeScript packages, those `ibusWeb.typescript.publishedPackages` lists, are packed from their build in the
workspace, so pnpm rewrites their `workspace:` and `catalog:` versions and `tools/pack-licenses` runs. A package whose
files a Nix build makes says so with `"ibusWeb": { "nixBuilt": true }` in its `package.json`, holds nothing else but its
README and the `CHANGELOG.md` Changesets writes, and adds its own tarball to `ibusWeb.typescript.npmPackages` from its
`module.nix`, passing the `license` its contents have: `@ibus-web/runtime` (`docs/runtime.md`) and each engine's
(`docs/engines.md`). `checks.typescript-npm` builds `npm.all`, and `checks.tools-pack-licenses-tarball` looks in
worker-host's for the license of the `effect` it bundles.

## Editor tooling

- **clangd** is the LLVM Emscripten drives, so its builtin headers match, wrapped with `--query-driver` trusting
  pkgsWasm's compiler. `.clangd` is `packages.clangd-config`, built from the flake, giving loose sources (those without
  a compilation database) the cross compiler, the common flags, an explicit `-resource-dir`, the dev libraries' include
  paths, and per-path flags from `ibusWeb.toolchain.clangdPathFlags` (GoogleTest's headers for tests, a test's `-D`s).
  The dev shell rebuilds the link on entry, so it follows the flake; `checks.toolchain-clangd` runs `clangd --check` on
  every C and C++ source in the repository, so the configuration can't drift from the build. A module that adds sources
  needing extra flags adds a `clangdPathFlags` entry beside them; `.envrc` already watches every module.
- **Claude Code** gets language servers through plugins, enabled in `.claude/settings.json`: `clangd-lsp` and
  `typescript-lsp` from the official marketplace, and `nixd-lsp` and `pkl-lsp` from the repository's own marketplace
  (`.claude-plugin/marketplace.json`, plugins under `tools/claude/`). The plugins only name commands; the servers come
  from the dev shell. **Start Claude Code inside the dev shell** (a direnv shell, or `nix develop -c claude`), or the
  servers won't resolve. The shell's greeting says so. Each plugin's `plugin.json` declares its server; the marketplace
  lists the plugins and their sources only. `checks.tools-claude-plugins` checks that the settings name the repository's
  root as the marketplace (Claude Code resolves the `directory` source's `.` against the project root:
  `claude plugin marketplace list` shows the checkout), that each source holds a `plugin.json` agreeing with the
  marketplace's entry, that every enabled `@ibus-web` plugin is listed, and that the dev shell provides each server
  command.
- **TypeScript's server.** The official plugin runs `typescript-language-server --stdio`, which speaks to tsserver;
  TypeScript 7 ships no tsserver, and its compiler serves LSP itself. The dev shell's `typescript-language-server` is a
  shim that execs the workspace's `tsc --lsp --stdio`, so the editor and `tsc` are always the same version. It ignores
  every flag but `--stdio` and offers only what TypeScript 7's LSP does.
- **nixd** and **pkl-lsp** from nixpkgs serve `.nix` and `.pkl` files.

## Flake inputs

An input comes from FlakeHub (`https://flakehub.com/f/<org>/<project>/<version>`) when the project publishes there
**and** its latest FlakeHub release is current with upstream's default branch; otherwise from `github:`. Some projects
stopped publishing to FlakeHub, so check before switching (compare the latest release's revision with upstream's head),
and take the latest release when switching. nixpkgs, flake-parts and github-actions-nix come from FlakeHub; import-tree,
devshell, flake-root, systems and files, which have no current FlakeHub entries, from GitHub.

## Flake apps

- **`nix run .#write-files`** writes every generated file ([the dev shell](#the-dev-shell) lists them).
- **`nix run .#demo`** serves the demo of every module ([examples/demo](../examples/demo/README.md)).
- **`nix run .#keystroke-bench`** times a production-preview browser run of trusted keys ([testing.md](testing.md)).
- **`nix run .#protocol-bench`** times decoding a framed 500-candidate lookup table from the built workspace. It is an
  app rather than a check, since wall-clock timing on a loaded builder means nothing
  ([protocol.md](protocol.md#lookup-decode-measurement)).

## CI

### Written in Nix

The workflows are Nix (`modules/flake/ci.nix`) through `github-actions-nix`; the `files` flake module writes them into
the tree as `.github/workflows/ci.yml`, `release.yml` and `reproducibility.yml`. Never edit the YAML:

- `nix run .#write-files` (or `write-files` in the dev shell) rewrites every generated file.
- `checks."files:.github/workflows/<name>.yml"` fails while a tracked file differs from what the Nix generates, so a
  change to `ci.nix` without `write-files` fails `nix flake check`.
- The writer lists the files it manages in `.generated-files`, itself generated, and deletes a file that list names once
  the Nix no longer configures it, so a workflow removed from the Nix leaves the tree at the next run.
- The generator writes its own header line, so the workflows' SPDX annotation is in `REUSE.toml`.
- actionlint (in hk) checks the generated files. It knows only GitHub's own runner labels, so `ci.nix` also writes
  `.github/actionlint.yaml`, naming the WarpBuild labels the workflows use.

### Runners

Every job runs on WarpBuild: `warp-ubuntu-latest-x64-8x` for x86_64-linux, `warp-ubuntu-latest-arm64-8x` for
aarch64-linux and `warp-macos-26-arm64-6x` for aarch64-darwin. The Linux runners have 150 GB of disk, enough for a cold
run, which rebuilds the patched Emscripten and everything WebAssembly; eight cores keep one within the jobs' 360-minute
limit. A job that builds with Nix:

- checks out;
- installs Determinate Nix;
- on Linux, allows unprivileged user namespaces (`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, where
  the runner has the setting). Ubuntu 24.04's AppArmor forbids them, and Chromium's sandbox, which the browser checks
  keep on, needs them;
- enables FlakeHub Cache;
- builds with `--max-jobs 1`, so cold compilation and CPU-bound test checks don't compete for the runner's cores.

Each job adds `id-token: write` to the workflow's `contents: read`, since Determinate Nix and FlakeHub authenticate with
the job's OIDC token.

### What it does

`ci.yml` runs on pull requests and on pushes to `master`. A pull request's new push cancels its run in progress
(`concurrency`, grouped by pull request); every push to `master` keeps its own run.

- **`check-x86_64-linux`**, **`check-aarch64-linux`** and **`check-aarch64-darwin`** run
  `nix flake check -L --system <system> --max-jobs 1`.
- **`integration`** runs `nix build .#integration-checks -L --max-jobs 1` on x86_64-linux.
- **`playwright-macos`** builds `packages.aarch64-darwin.playwright-integration`, the Playwright suite with Playwright's
  macOS WebKit, closer to Safari than its Linux build. The rest of `integration-checks` gains nothing from a second
  system at macOS's price, about 13 times Linux's.
- **`safari`** enables safaridriver (`sudo safaridriver --enable`) and runs `nix run .#safari-smoke` on the macOS
  runner, the WebDriver smoke suite in real Safari ([testing.md](testing.md#safari-and-webdriver)). It and
  `playwright-macos` need `check-aarch64-darwin`, so they substitute the WebAssembly it built from FlakeHub Cache rather
  than each building it again at macOS's price.
- **`publish`** needs every other job, and runs only on a push to `master`
  (`if: github.event_name == 'push' && github.ref == 'refs/heads/master'`). It publishes the flake to FlakeHub as
  `synapdeck/ibus-web`, rolling (`flakehub-push`), within 30 minutes. Its visibility follows the repository's
  (`github.event.repository.private`): private while the repository is, public once it is. FlakeHub Cache grants access
  per published flake, so the cache needs this flake published; only a `master` that passed every job is.

`release.yml` and `reproducibility.yml` are in [Releases](#releases).

Actions are pinned to release tags: `actions/checkout@v7.0.1`; `determinate-nix-action` and `flakehub-cache-action` both
at one `determinateVersion` (`v3.23.0`), since they release together and mismatched versions are untested against each
other. `flakehub-push` follows its major tag, `v7`: it is tagged by major version only, so it can't be pinned to a
release. To bump one, edit `ci.nix`, then `nix run .#write-files`.

### The cache

FlakeHub Cache holds what CI builds, so a later run substitutes the patched Emscripten, the cache, pkgsWasm's packages
and the checks instead of building them. Pull requests from forks get no cache: GitHub's token for a fork's pull request
lacks the claims FlakeHub Cache needs, so those runs build from scratch.

To read the cache on a workstation, install Determinate Nix and run `determinate-nixd login`, which authenticates it to
FlakeHub (access is per flake, granted through the organisation). Then a build substitutes from `cache.flakehub.com`;
`nix build -L .#checks.x86_64-linux.flake-hk` should show `copying path … from 'https://cache.flakehub.com'`.

## Releases

Changesets versions the published packages and writes their changelogs; a tag publishes them.

- **Changesets** (`tools/release`, whose package depends on `@changesets/cli`). `.changeset/config.json` is generated
  (`tools/release/changesets.nix`): every published package (`ibusWeb.typescript.publishedPackages`, the engine packages
  among them, which is why `packages/engines/*` is in the pnpm workspace) is in one `fixed` group, so a release has one
  version, which names its assets; private packages aren't versioned; Changesets formats nothing, since hk formats what
  it writes as it is committed. In the dev shell, `changeset` runs the CLI at the repository's root: `changeset` to
  describe a change, `changeset version` to apply the pending ones. Versioning is local: run `changeset version`,
  commit, then tag `v<version>`.
- **`.#release`** (x86_64-linux only: its outputs are WebAssembly and JavaScript, the same whatever builds them) holds
  `assets/`, the GitHub release's files, and `notes.md`, its text. The assets (design spec §10.7) are every npm tarball
  (`legacyPackages.<system>.npm.all`), `ibus-runtime.js` and `ibus-runtime.wasm`, `PROTOCOL.md`, each engine's
  distribution (its `.wasm`, data archives and manifest) as `engine-<name>-<version>.tar`, each engine's source bundle,
  and `release.json`, which lists each asset's size and SHA-256 with the version, the commit and the runtime ABI. The
  notes are each package's section of its changelog for the version (`tools/release/notes.ts`), leaving out packages
  Changesets bumped without changes; the build fails while a changelog lacks the version.
- **Source bundles** (`packages.engine-<name>-src`, design spec §9.3), one `.tar.xz` per engine: the repository as
  tagged, every flake input (nixpkgs among them) as Nix fetched it, and under `sources/` the upstream source of every
  library the engine and the runtime link, of Emscripten, and of what `ibusWeb.release.engines.<name>.extraSources`
  names (its data, and dependencies its build fetches other than as build inputs). Its README says how to build the
  engine from the repository and the flake inputs; Nix still fetches the upstream sources by their pinned hashes, and
  the copies under `sources/` keep them at hand should an upstream go away. `checks.tools-release-source-bundles` fails
  when an engine the demo serves has no bundle, and `integration-checks` builds every bundle
  (`ibusWeb.testing.extendedChecks.release-source-bundles`), so one that can't be built fails before a tag is pushed.
- **`release.yml`**, on a `v*` tag. The `release` job, on the x86_64-linux runner with `contents: write`, builds
  `.#release`, checks that the tag is `v` and its version, creates the GitHub release from `assets/` with `notes.md`
  (`gh release create --verify-tag`), and uploads the npm tarballs as an artifact. The `npm` job then runs `npm publish`
  on each on GitHub's `ubuntu-latest`, under Node 26 from `actions/setup-node`, with `id-token: write`: npm's trusted
  publishing exchanges the job's OIDC token for a short-lived credential and accepts only GitHub-hosted runners. No npm
  token is stored, and npm attaches provenance. It needs npm 11.5.1 or later, which Node 26 carries. A version already
  on the registry is skipped, so rerunning the `npm` job finishes a partial publish. Each package on npmjs trusts this
  repository's `release.yml`. npm sets that up only for a package that exists, so a newly published package first needs
  a placeholder version published by hand, then
  `npm trust github <name> --file release.yml --repo synapdeck/ibus-web --allow-publish`.
- **`reproducibility.yml`**, weekly and on demand, builds the runtime and each engine's side module, then builds them
  again with `--rebuild`, which compares the new outputs with the first; once a release's changelogs exist, it does the
  same for `.#release`. `--rebuild` compares only the derivations it names.

`checks.tools-release` runs the notes tool's tests; `checks.tools-release-changesets` versions a copy of the repository
with a sample minor changeset in place of any pending ones and checks that every published package takes the new
version, no private one moves, and the notes come out of the changelogs written.
