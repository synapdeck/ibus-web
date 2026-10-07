# Repository organization

ibus-web began as a proof of concept and grew one milestone at a time, so its layout records the order things were
built in rather than a plan. TypeScript lives in directories that are not packages, so the root `package.json` carries
their dependencies. 65 tsconfig files are spread through `src/` and `test/` subfolders. Nix modules use four names for
the same role, and shared helpers are re-derived in each file that needs them. Nothing tells a newcomer where to start.

This design sets one layout for the TypeScript, one for the Nix, and the documents a contributor reads first. It changes
no behaviour: every check that passes before passes after, and no published API that a consumer uses changes.

## Goals

- Every directory containing TypeScript is a workspace package whose `package.json` declares exactly what it imports.
  The root `package.json` has no dependencies.
- Every tsconfig sits at a package root and extends a shared preset or its own package's `tsconfig.json`.
- Every Nix file's name says its role, and every component's Nix sits beside the component.
- Helpers copied between Nix files exist once.
- A newcomer, human or agent, can find what the project is, how to build it and how to contribute from the repository
  root.

## Non-goals

- Rewriting working logic. Large functions such as `makeRouter`, `makeEngineRegistry` and `createIbusWeb` stay as they
  are; files are split only along seams that already exist.
- Changing upstream patch contents (`modules/emscripten/patches`, `modules/glib/patches`, `engines/hangul/patches`).
- Publishing packages, adding Changesets, or making the repository public.
- The `codex/table-engine` branch. It is kept as a reference for a second attempt at the table engine, not merged.

## TypeScript

### Shared compiler presets

A private workspace package, `packages/tsconfig` (`@ibus-web/tsconfig`), holds the compile environments. Every package
lists it as a devDependency and extends one of its presets:

| Preset               | For                                                                         |
| -------------------- | --------------------------------------------------------------------------- |
| `base.json`          | The strict options every config shares: today's root `tsconfig.base.json`   |
| `dom.json`           | Page code and browser tests                                                 |
| `worker.json`        | Code that runs in a dedicated Worker                                        |
| `node.json`          | Tools, Node tests and build-time scripts that Node runs with types stripped |
| `emscripten-js.json` | JavaScript Emscripten bundles as scripts: `--js-library`, `--pre-js`        |

The package also ships the WebAssembly declarations Node's types lack (today's `types/webassembly`), and `node.json`
lists them in `types`, so the `typeRoots` workaround goes away. The root `tsconfig.*.json` files, `types/`, and every
per-package `tsconfig.base.json` are deleted.

### One tsconfig per configuration, at the package root

A package has one tsconfig for each distinct compile configuration, all beside its `package.json`:

- `tsconfig.json`, which references the others and is what editors open
- one per build target the package has, named for it: `tsconfig.page.json`, `tsconfig.worker.json`,
  `tsconfig.shared.json`
- `tsconfig.test.json` for Node tests, `tsconfig.test-browser.json` for browser tests
- `tsconfig.config.json` for `tsdown.config.ts` and `vitest*.config.ts`

A package with one configuration has only `tsconfig.json`. No tsconfig sits in a subfolder, and none exists only to
re-extend another. The `tsconfig-extends` check enforces the rule: every tsconfig extends an `@ibus-web/tsconfig` preset
or its own package's `tsconfig.json`, and sits at a package root.

### Tools: one package per tool

`tools/package.json` and `tools/vitest.config.ts` are deleted. Each `tools/<name>/` is a private package
`@ibus-web/<name>` with its own `package.json`, tsconfig, vitest config and `module.nix`. Its dependencies are the ones
it imports: tree-sitter and SARIF belong to `cast-audit` alone, the mdast libraries to the tool that reads Markdown.

Scripts that Nix or hk run as programs move out of the module directories into tools:

| From                                                                 | To                                            |
| -------------------------------------------------------------------- | --------------------------------------------- |
| `modules/flake/tsconfig-extends.ts`                                  | `tools/tsconfig-extends`                      |
| `modules/typescript/assert-dependency.ts`                            | `tools/assert-dependency`                     |
| `modules/testing/expect-results.ts`                                  | `tools/expect-results`                        |
| `modules/glib/checks/tests/` (`gate.ts`, `gate.test.ts`)             | `tools/glib-test-gate`                        |
| `modules/toolchain/{instantiate,minimum-versions,probe-features}.ts` | `tools/toolchain-probes`, three entry points  |
| `runtime/wasmfs-idb/library-deps.ts`, `library-deps.test.ts`         | `tools/emscripten-library-deps`               |
| `docs/upstream/evidence/idb-sync-calls/measure.ts` and its tsconfig  | Removed with the evidence (see Documentation) |

### Component packages

JavaScript Emscripten compiles into a module is part of that component and stays with it: `--pre-js` and `--post-js`
files, `libwasmfs_idb.js`, `gtest-main/report.js`, `host-memory.js` and their declarations. A component with such files,
or with Vitest suites that drive its wasm build, has a private `package.json` and tsconfigs at its root, as
`runtime/wasmfs-idb` does today:

- `runtime/wasmfs-idb` (`@ibus-web/wasmfs-idb`)
- `runtime/ibus-runtime` (`@ibus-web/ibus-runtime`), which absorbs `tests/load.test.ts` and `tests/harness.ts`
- `modules/emscripten` (`@ibus-web/emscripten-checks`), for `checks/fixes`
- `modules/testing` (`@ibus-web/testing`), for the gtest report library

### The example absorbs the end-to-end tests

`tests/playwright/` moves to `examples/hangul/test/e2e/`. Its tests drive the demo and nothing else, and the move lets
the demo and its tests share one Nix setup. `examples/hangul` is renamed `@ibus-web/example-hangul`, its `build` script
(which only type-checks) becomes `typecheck`, and its smoke test gets a script.

### The workspace

`pnpm-workspace.yaml` lists `packages/*`, `tools/*`, `examples/*` and the component packages. The root `package.json`
keeps `name`, `private`, `type` and `packageManager`, and no dependencies.

### Inside the packages

Every package uses the same layout. `src/` has environment subfolders only where the package builds for several
targets. `test/` splits by environment: `test/node/`, `test/browser/` and, for code both run, `test/shared/`. No tests sit
inside `src/` or loose at the root of `test/`. Tests use `test`, not `it`.

Specific moves:

- Core's five DOM router tests (`contexts`, `preedit`, `surrounding`, `content-type`, `switching`) move into
  `test/browser/`. This removes the four lists that name them in vitest and tsconfig files.
- `packages/test-programs/src/*.test.ts` move to `test/`; protocol's loose `manifest.test.ts` and `settings.test.ts` move
  into an area folder.

Code that is copied between packages exists once:

- The panel's record and event types (`PanelRecord`, `PanelEvent`/`PanelUpdate`, `PanelAction`) are defined in
  `@ibus-web/protocol`. Core and panel import them; `ibus-web` builds its `PanelAction` schema from the same definition.
- One helper turns an unknown thrown value into a message, in protocol, replacing `asError`, `error`, `messageOf` (twice),
  `briefly` (twice) and the two `describe`s.
- `align`, `alignedSize`, `nonEmpty`, `nodeFs` and `INSTALL_PIECE` each have one definition, imported where used.
- Worker-host's browser and Node harnesses share `test/shared/harness.ts`. Test fixtures copied between packages
  (`HANGUL_SCHEMA`, `stringValue`, `emptyReply`) move to the package that owns the data and are imported from there.
  Magic capability numbers use `IBusCapability`.

Each package exports exactly what consumers import:

- Barrel files list their exports instead of `export *`.
- Worker-host stops re-exporting protocol's transport; core imports `transportLayout` from protocol.
- Exports used nowhere, or only in their own file, stop being exported.

`packages/worker-host/src/worker/host.ts` splits along its seams. Crash and log formatting joins `failure.ts`, each layer
gets its own file, the request loop moves to `serve.ts`, and `host.ts` keeps the composition. `worker/store.ts` is
renamed so it no longer shares a name with `install/store.ts`. `core/test/connection/connection.test.ts` gains
`describe` groups. Ad hoc `console.log` measurements in tests use the harness's `record` reporter.

### Package metadata

The five publishable packages (protocol, worker-host, core, panel, ibus-web) all have:

- a README of a few paragraphs linking to their page under `docs/`
- `homepage` pointing at that docs page
- `sideEffects`, `engines.node` and `keywords`
- `prepack` and `postpack` scripts that run `tools/pack-licenses`, and sourcemaps enabled in their tsdown config

Panel drops `effect`, which it never imports.

### Licences in packed packages

A package's tarball must carry the licence of everything bundled into it. Worker-host bundles `effect` and
`brotli-dec-wasm` into `dist/worker`, which ibus-web copies into `dist/host`, and today neither ships those licences;
core's are copied by a hand-written `cp` list. No package keeps a `LICENSES/` directory in the tree.

`tools/pack-licenses` (`ibus-web-pack-licenses`) derives the licences from what the build bundled:

- `prepack` reads the `sources` of every sourcemap under the package's `dist/`. For each file from the repository, it
  takes the SPDX licence from REUSE's data (the file's header or its `REUSE.toml` annotation) and copies
  `LICENSES/<id>.txt`. For each file from `node_modules`, it copies that dependency's own licence file to
  `LICENSES/<package>.txt`. It copies a `NOTICES/*.txt` file when a bundled file is one the notice covers, from a small
  map in the tool, and always copies `LICENSE-MIT` and `LICENSE-APACHE`. It records what it wrote in a manifest.
- `postpack` deletes exactly the files the manifest lists, and the manifest.
- `--check` runs the same derivation against a built package without writing, and fails when a bundled source has no
  licence it can find. A Nix check runs it on every publishable package, so a new bundled dependency without a licence
  fails CI instead of shipping silently.

A package with sourcemaps turned off fails `--check`. The files `prepack` writes are ignored by the root `.gitignore`.

## Nix

### Where it lives

A component's Nix sits in the component's directory: `packages/*`, `tools/*`, `runtime/*`, `engines/*`, `examples/*`.
`modules/` keeps only shared infrastructure: `flake/`, `toolchain/`, `emscripten/`, `glib/`, `typescript/` and
`testing/`. `flake.nix` import-trees `modules`, `packages`, `tools`, `runtime`, `engines` and `examples`.

Moves:

- `modules/demo.nix` and `modules/playwright.nix` join `examples/hangul/module.nix` and share one workspace and font
  setup.
- `modules/keys.nix` moves to `tools/keysyms/module.nix`, with the list of generated notices that
  `modules/typescript/default.nix` special-cases today.
- `modules/libhangul/` folds into `engines/hangul/`. Its patch is applied by the same directory scan as Hangul's own,
  and its link check tests the patched library that `hangul.wasm` links.
- The Emscripten parts of `modules/flake/dev-shell.nix` move to `modules/emscripten/`.
- `runtime/options.nix` splits into an `options.nix` in each runtime component, beside the code that sets them.
- `ibusWeb.engines.hangul` moves from `modules/engines/options.nix` to `engines/hangul/options.nix`. The generic engine
  modules (`cast-audit`, `ibus-test`, `manifest`, `settings-metadata`) stay in `modules/engines/`.
- The library checker and type generator in `runtime/wasmfs-idb/types.nix` move with their script to
  `tools/emscripten-library-deps/module.nix`.

### File roles

Every directory names its files by role:

| File          | Role                                                                     |
| ------------- | ------------------------------------------------------------------------ |
| `module.nix`  | The component's flake-parts module: its packages, outputs, devshell bits |
| `options.nix` | Options the component declares for other modules to read                 |
| `checks.nix`  | Its checks                                                               |
| `overlay.nix` | Its overlay on `pkgsWasm`, when it has one                               |
| `_<name>.nix` | A plain `callPackage` recipe, which import-tree skips                    |

A module with more than one job splits into further modules named for each job (`archives.nix`, `exports.nix`). A check
with its own fixtures gets a directory holding a `checks.nix`, as in `engines/hangul/checks/golden/checks.nix`. No file
is named `default.nix`, and none named `package.nix` is a flake-parts module.

### Shared helpers

`modules/flake/lib.nix` declares `ibusWeb.lib`, the helpers each copied today:

- `patchesIn dir`: the `.patch` files under a directory, in order
- `isEmscriptenWasm platform`: the overlay guard
- `nativeIbusConfig { … }`: the native IBus session config the conformance and differential checks share
- `mesonAllTestsRan`: the gate that fails a Meson test run that skipped or ran nothing
- `emscriptenRoot` and `wasmfsIncludeFlag`
- the test link flags without the Node host filesystem
- `emscriptenTypes`: a `.d.ts` emitted from a JavaScript library, with its devshell out-link. It replaces two copies of
  the recipe and four hardcoded `emscripten-types` paths.

The three hand-built "tools tree plus `node_modules`" derivations become `typescript.workspaceFor [ "tools/<name>" ]`.

### Splitting the large modules

- `modules/typescript/default.nix` (403 lines) becomes `workspace.nix` (pnpm dependencies, `node_modules`,
  `workspaceFor`), `files.nix` (generated `pnpm-workspace.yaml` and the like) and `tsc.nix`.
- `modules/testing/default.nix` (549 lines) becomes `gtest.nix`, `programs.nix` (the test-program runner), `vitest.nix`
  and `playwright.nix` (browsers and their environment), each with the options it owns.

### Dead and misplaced options

- Removed: `testing.gtestMain` (no consumer), `testing.playwright.browsers` (never read),
  `runtime.wasmfsIdbTestLibraries` (becomes a `let` in its only user).
- `testing.jsonGlib` builds production `settings.json` for every engine, so it moves out of `testing` to
  `modules/engines/`.
- The checked-in `.clangd` files under `runtime/` and `modules/toolchain/checks/` go; the generated
  `toolchain.clangdPathFlags` covers those paths.
- The descriptions of `installArchives` and the comment in `archives.nix` list every archive the module produces.

### Naming

Every derivation name starts `ibus-web-`. Check names are `<area>-<what>`, where the area is the directory's component:
`hangul-golden`, `tools-cast-audit`, `glib-settings-listeners`.

## Repository hygiene

- `.gitignore` gains `.artifacts/`, `.claude/settings.local.json` and the files `prepack` copies into packages.
- `.editorconfig` gains a `[*]` section: UTF-8, LF, final newline, two-space indentation, matching what the formatters
  already produce.
- Branches `backup/master-before-ci-squash`, `fix/ci-integration-verified` and `fix/ci-test-scheduling` are deleted,
  locally and on `origin`. `codex/table-engine` becomes the tag `archive/table-engine`, its worktree is removed, and the
  branch is deleted.
- The FlakeHub publish step's visibility follows the repository's:
  `${{ github.event.repository.private && 'private' || 'public' }}`. The flake stays private while the repository is,
  and the first publish after the repository goes public lists it. FlakeHub's documentation doesn't say whether a push
  can change an existing flake's visibility; if the first public push doesn't, it is changed once by hand in FlakeHub's
  settings.
- `id-token: write` moves from the workflow to the jobs that use FlakeHub, so pull request jobs from forks don't get it.

## Documentation

### The front door

- `README.md`: what ibus-web is, the GPL boundary between the page packages and the engines, a quick start with
  `nix run .#demo`, a map of the repository and a map of `docs/`.
- `CONTRIBUTING.md`: the dev shell and direnv, hk and its hooks, `nix run .#write-files` for generated files, REUSE
  headers, Conventional Commits with the scopes in use, and how to run the checks locally and in CI.
- `AGENTS.md`, and a `CLAUDE.md` that points to it: the layout conventions in this document, the generated files never
  edited by hand, committing through `nix develop -c git commit` with named paths, and the comment style.
- `SECURITY.md`: how to report a vulnerability privately.

### Living pages

- Stale claims are corrected: M1 work described as future in `runtime.md` and `engines.md`; CI described as never run in
  `known-gaps.md`; `tooling.md`'s CI section, which omits the integration job, and its list of what `write-files`
  writes. `ibus-web.md`'s install instructions say the packages are not published yet.
- The spec's repository layout (§10.1) is redrawn from the tree this document produces.
- `docs/README.md` indexes every page, the differential-testing spec, `PROTOCOL.md`, the example and tools READMEs and
  each patch README.
- hk gains a link check over Markdown, so the links that all resolve today keep resolving.

### Historical material

- The six implementation plans in `docs/plans/` are deleted. Their milestones are done, and git history keeps them.
- `docs/upstream/` keeps the drafts, which record why each Emscripten patch exists. The posting queue in its README
  becomes a status table, the drafts' "Notes for the user" sections become "Evidence", and
  `docs/upstream/evidence/idb-sync-calls/` leaves the repository; its README's summary of the measurements stays in
  `storage.md`.
- The Emscripten patch README's row for 0008 names its own draft.

## Order of work

The work lands on one branch as a sequence of commits, each of which passes `nix flake check` and
`nix build .#integration-checks`, with `pnpm-lock.yaml` and every generated file regenerated by
`nix run .#write-files`:

1. `@ibus-web/tsconfig` and the per-package tsconfig layout
2. Tools split into packages, and the loose scripts moved into them
3. Component packages, the example absorbing the end-to-end tests, the empty root `package.json`
4. Nix file roles and moves
5. Nix shared helpers, module splits, dead options and naming
6. Package internals: test layout, deduplication, exports, the `host.ts` split
7. Package metadata and `tools/pack-licenses`
8. Repository hygiene
9. The front door and documentation, written against the final layout

Branch and tag deletion on `origin`, in step 8, waits for confirmation at that point.
