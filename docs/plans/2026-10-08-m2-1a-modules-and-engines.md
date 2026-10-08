# M2.1 Phase 1: Modules and Engines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach the page side the difference between a module (one manifest, one Worker) and the engines inside it: rename the page API and protocol types to "module", replace the manifest's engine names and module-wide keyboard with engine descriptors, let the router switch engines inside one Worker and deselect, and turn `examples/hangul` into a data-driven `examples/demo`.

**Architecture:** The rename is mechanical and lands first, with no behaviour change. Engine descriptors then replace `engines: string[]` and `keyboard` in `ModuleManifest`; the registry keeps each engine's keyboard policy and every input context records the engine it created, so the key path follows the context's engine. The router's selection becomes `{ module, engine }`: a surface keeps one context per module, and switching engine inside a module destroys that context's engine and creates the new one in the same Worker. The demo reads a module → manifest map built from `ibusWeb.demo.modules` and lists every engine through `engines(module)`.

**Tech Stack:** TypeScript 7 (tsgo), Effect 4, Vitest 5 (Node and browser mode), Playwright 1.63, Vite 8, Nix flake-parts with import-tree, pnpm, hk (oxfmt, oxlint, tsc, nixfmt, reuse, lychee).

## Global Constraints

From the cross-phase contracts (Produced by A), verbatim:

- `EngineDescriptor` schema and type: `{ name: string; displayName: string; languages: string[]; keyboard: { layout: "us" | "default"; passThrough: string[] } }`. `name`, `displayName` non-empty; unknown keys rejected.
- `EngineManifest` is renamed `ModuleManifest` (and its decoder `decodeModuleManifest`). Its `engines` field becomes `EngineDescriptor[]` (non-empty, unique names); the top-level `keyboard` field is removed. Every other field is unchanged.
- `ibusWeb.engines.mkEngineManifest` keeps its name and drops the `keyboard` argument. Its `engines` argument is either a list of descriptor attrsets (same shape as `EngineDescriptor`) or a path/derivation to a JSON file containing an array of them. The JSON is validated by the existing manifest `check` step, not by Nix.
- Hangul's call: `engines = [ { name = "hangul"; displayName = "Hangul"; languages = [ "ko" ]; keyboard = { layout = "us"; passThrough = [ ]; }; } ];`
- Demo modules are data-driven: `examples/demo/options.nix` declares `ibusWeb.demo.modules`, an `attrsOf package` of module distributions (`ibus-web-<name>-dist` outputs) keyed by module name. `engines/hangul/module.nix` sets `ibusWeb.demo.modules.hangul`. The demo's build, dev server and checks serve every entry and hand the page the module → manifest URL map; nothing in `examples/demo` names Hangul except its Hangul tests.
- `EngineRegistry` → `ModuleRegistry`; facade option `engines` → `modules: Readonly<Record<string, URL>>`.
- Router: `select(module: string, engine?: string)`, `deselect()`, `unload(module)`, `override(adapter, selection: { module: string; engine?: string } | undefined)`, `activeContext()` returns `{ module, engine, ic, adapter }`, a `selection` getter `{ module: string; engine: string } | undefined`, and a stream of selection changes.
- Facade: `select(module, engine?)`, `deselect()`, `unload(module)`, `debugRestart(module)`, `engines(module): Promise<EngineDescriptor[]>` (fetches and validates the manifest; starts no Worker), `readonly selection`, events `modulestate` (was `enginestate`) and `selectionchange` (`CustomEvent<{ module: string; engine: string } | undefined>`); log entries and panel updates carry `module` (was `engine`).
- Selecting an engine sends `CreateEngine{ name: engine }`; the keyboard policy is the active engine descriptor's.
- `examples/hangul` → `examples/demo`, package `@ibus-web/example-demo`, check `example-demo-smoke`, `packages.demo` and `nix run .#demo` unchanged in name.
- The page builds an engine picker from `engines(module)` for every module, and binds a shortcut (Shift+Space, which the Hangul demo used for switching) that toggles between `deselect()` and the last selection.
- Playwright specs are per module: `examples/demo/test/e2e/hangul.spec.ts` (and shared helpers beside it).

From the spec (`docs/specs/2026-10-08-m2-1-table-engine.md`), verbatim:

- "The repository's `engines/<name>/` directories, the Nix options under `ibusWeb.engines` and the npm names `@ibus-web/engine-<name>` keep their names."
- "The first engine is the module's default. The list is non-empty, names are non-empty and unique, and unknown keys are rejected as elsewhere in the manifest."
- "`select(module, engine?)` selects an engine; without `engine`, the module's default. An unknown module or engine is rejected before anything changes."
- "Switching engine within the selected module reuses its Worker. Each surface's context is drained and reset as on any switch today, and a new context is created with `CreateEngine{engine}`."
- "`deselect()` returns every surface to plain browser input. Compositions finish through the same drain and reset; Workers stay loaded."
- "`engines(module): Promise<EngineDescriptor[]>` fetches and validates the module's manifest without starting a Worker."
- "There are still no built-in hotkeys: hosts bind their own."
- "Switching between two engines of one module is tested in core against a fake host."

From the repository's rules (`AGENTS.md`, `CONTRIBUTING.md`):

- Work on branch `typedrat/m2-1a-modules-and-engines`, cut from `master`. Work in the main checkout, never under `.worktrees/`.
- Run every command inside the dev shell (`nix develop -c <command>`). Never search from `/`.
- `git add` a new file before any `nix` command that should see it.
- Generated files are never edited by hand: `.github/workflows/ci.yml`, `pnpm-workspace.yaml`, `packages/protocol/PROTOCOL.md`, `runtime/libibus-web/include/ibus-web/protocol.h`, `packages/core/src/keys/*.generated.ts`, `NOTICES/*.txt`, `LICENSES/LicenseRef-xkeyboard-config.txt`. None of them changes in this plan; `nix run .#write-files` must leave `git status` clean of them.
- `pnpm-lock.yaml` changes only through the importer rename in Task 4; if the `pnpmDeps` hash in `modules/typescript/workspace.nix` then mismatches, take the new value from the build's error.
- Stage named paths only (`nix develop -c git add <paths>`), never `git add -A` or `git add .`. Commit with `nix develop -c git commit -m "<type>(<scope>): <summary>" -- <paths>`. No AI attribution lines. If hk's pre-commit hook rejects or changes files, fix the cause and commit again; never bypass it.
- Every new file starts with `SPDX-FileCopyrightText: 2026 Synapdeck, Inc.` and `SPDX-License-Identifier: MIT OR Apache-2.0` in its comment syntax.
- Moves use `git mv`.
- Code: separate logical blocks with a blank line; never a blank line right after an opening token or right before a closing one, nor between a comment and its code. Comments explain why, never what; no history narration, no references to other files, plans or pull requests. Match the surrounding comment density. Never whitespace-minimize code.
- Docs in `docs/` describe the code as it is; each task updates the pages its change affects. Format Markdown and TypeScript with `nix develop -c oxfmt <files>`. **Never run oxfmt on `docs/plans/`**, this file included.
- Never revert, reformat or "fix" changes you didn't make.
- Report which checks ran and what failed; don't summarize a check you didn't run as passing.

## Decisions this plan makes

These follow from the real code and are fixed for Plans B and C:

1. **The demo's toggle shortcut is Ctrl+Space, not Shift+Space.** Shift+Space is ibus-hangul's own Hangul/Latin toggle (the `hangul-keys` setting); every Hangul Playwright test presses it, and the spec says Hangul's tests move unchanged. A page shortcut on Shift+Space would swallow it before the engine. Ctrl+Space is the classic IBus trigger and no shipped engine binds it.
2. **`selectionchange` carries `null`, not `undefined`, after deselection.** A `CustomEvent` turns an undefined `detail` into `null`, so the event map types it `CustomEvent<Selection | null>`. The `selection` getter stays `Selection | undefined`.
3. **The router's stream of selection changes is `selectionChanges: Stream.Stream<Selection | undefined>`**, and the selection type is exported from `@ibus-web/core` (and `ibus-web`) as `Selection { readonly module: string; readonly engine: string }`.
4. **`deselect()` also clears every surface override**, since the spec says it returns every surface to plain browser input.
5. **A selection whose module's manifest hasn't been read yet waits in the router's mailbox** while `registry.engines(module)` reads it. Until it applies, surfaces following the page want no context (so a stale engine's late output is dropped, as today's synchronous selection does), and a later selection supersedes it. A selection of a module whose manifest is loaded validates and applies synchronously, exactly as today.
6. **The rename covers the whole page side**: `ModuleSnapshot`, `ModuleState`, `ModuleEvent`, `LogLine.module`, `InputContext.module`, `SettingsApi.layer({ modules })` and the settings methods' first parameter, `PanelHost.lookupTableOrientation(module)` and `sendPanelAction(module, …)`. Error messages say `Unknown module: <name>`. `packages/core/src/services/engines.ts` moves to `services/modules.ts`.
7. **Each input context records its engine**: `KeyContext` gains `readonly engine: string`, and `ModuleSnapshot.keyboard`/`passThrough` become `keyboards: ReadonlyMap<string, KeyboardPolicy>` keyed by engine name, so two surfaces can use two engines of one module at once (one through an override).
8. **`registry.engines(module)` failing marks a not-yet-started module `failed`**, as starting it would have; a later selection retries the read.
9. **The demo opens on the first module in name order** (`builtins.toJSON` sorts attribute names), so it keeps opening on Hangul when Plan C adds `table`.

## File map

| Path | Task | Role |
| --- | --- | --- |
| `packages/protocol/src/manifest.ts`, `src/index.ts`, `src/messages/panel.ts` | 1, 2 | `ModuleManifest`, `EngineDescriptor`, `PanelEvent.module` |
| `packages/protocol/test/engine/manifest.test.ts` | 1, 2 | descriptor decoding |
| `tools/engine-manifest/protocol.ts`, `protocol.test.ts` | 1 | the build's manifest check calls `decodeModuleManifest` |
| `packages/worker-host/**` (types and test manifests), `packages/worker-host/module.nix` | 1, 2 | type rename; test distributions with descriptors |
| `modules/engines/manifest.nix`, `modules/engines/options.nix` | 2 | `mkEngineManifest` takes descriptors, list or JSON file |
| `engines/hangul/module.nix` | 2, 4 | Hangul's descriptor; `ibusWeb.demo.modules.hangul` |
| `packages/core/src/services/engines.ts` → `services/modules.ts` | 1, 2, 3 | `ModuleRegistry`, per-engine keyboards, `engines(module)` |
| `packages/core/src/router/{keystroke,contexts,router}.ts` | 1, 2, 3 | `KeyboardPolicy`, `KeyContext.engine`, engine switching, `deselect`, `selection` |
| `packages/core/src/{services/logging,settings/api,page/index}.ts` | 1, 2, 3 | `LogLine.module`, settings by module, exports |
| `packages/core/test/**` | 1, 2, 3 | fixtures and new switching tests against the fake host |
| `packages/panel/src/{host,panel}.ts`, `test/browser/panel.test.ts` | 1 | `module` in panel updates |
| `packages/ibus-web/src/index.ts`, `test/**` | 1, 3 | facade |
| `examples/hangul/**` → `examples/demo/**`, `examples/demo/options.nix` | 1, 4 | the demo |
| `pnpm-lock.yaml` | 4 | importer `examples/demo` |
| `README.md`, `docs/{README,core,engines,ibus-web,panel,protocol,testing,tooling,known-gaps,worker-host}.md`, `docs/specs/2026-09-26-ibus-web-design.md`, `packages/{core,ibus-web,runtime}/README.md`, `packages/engines/hangul/README.md`, `examples/demo/README.md` | 1–4 | docs |

`packages/protocol/PROTOCOL.md` doesn't mention the manifest or panel events, so it doesn't change.

---

### Task 1: Name the page side's registry keys "modules"

A pure rename, no behaviour change: `EngineManifest` → `ModuleManifest`, `EngineRegistry` → `ModuleRegistry`, the facade's `engines` option → `modules`, `enginestate` → `modulestate`, and `engine` → `module` wherever it means the registry key (log lines, panel events, settings, the router's parameters).

**Files:**

- Move: `packages/core/src/services/engines.ts` → `packages/core/src/services/modules.ts`
- Modify (identifier rename): every file `git grep -l -E 'EngineManifest|EngineRegistry|EngineSnapshot|EngineState|EngineEvent|enginestate|services/engines\.ts' -- packages tools examples` lists (48 files across `packages/{protocol,worker-host,core,ibus-web}`, `tools/engine-manifest`, `examples/hangul/src/main.ts`, `packages/core/README.md`)
- Modify (`engine` → `module`): `packages/core/src/router/router.ts`, `packages/core/src/router/contexts.ts`, `packages/core/src/services/logging.ts`, `packages/core/src/settings/api.ts`, `packages/ibus-web/src/index.ts`, `packages/panel/src/host.ts`, `packages/panel/src/panel.ts`, `packages/protocol/src/messages/panel.ts`
- Modify (tests): `packages/core/test/browser/{real-host.ts,settings.test.ts,support/dom.ts}`, `packages/core/test/node/router/services.test.ts`, `packages/core/test/node/connection/connection.test.ts`, `packages/ibus-web/test/browser/facade.test.ts`, `packages/panel/test/browser/panel.test.ts`
- Modify (docs): `docs/core.md`, `docs/engines.md`, `docs/ibus-web.md`, `docs/known-gaps.md`, `docs/panel.md`, `docs/protocol.md`, `docs/worker-host.md`, `docs/specs/2026-09-26-ibus-web-design.md`, `packages/ibus-web/README.md`, `packages/engines/hangul/README.md`, `packages/runtime/README.md`

**Interfaces:**

- Consumes: nothing.
- Produces (names every later task uses):
  - `@ibus-web/protocol`: `ModuleManifest` (schema and type), `decodeModuleManifest(json, { minimum, maximum })`; `PanelEvent`/`PanelUpdate` carry `readonly module: string`.
  - `@ibus-web/core`: `ModuleRegistry` (service key `"@ibus-web/core/ModuleRegistry"`), `makeModuleRegistry`, `ModuleRegistryOptions { modules: Readonly<Record<string, URL>>; … }`, `ModuleRegistryService`, `ModuleEvent` (`{ _tag: "state"; module; state } | { _tag: "storage"; module; state; message }`), `ModuleSnapshot`, `ModuleState`, `LogLine { module; ic; record }`, `SettingsOptions { modules; … }`, `SettingsApiService.schemas(module)` etc.; `InputContext` has `readonly module: string`; `RouterService.select(module)`, `unload(module)`, `override(adapter, module | undefined)`, `activeContext(): { module; ic; adapter } | undefined` (Task 3 reshapes these).
  - `ibus-web`: `IbusWebOptions.modules`, `LogEntry.module?`, event `modulestate` with `{ module, state }`, `storage` with `{ module, state, message }`.
  - `@ibus-web/panel`: `PanelHost.lookupTableOrientation(module: string)`, `sendPanelAction(module: string, ic, action)`.

- [ ] **Step 1: Cut the branch**

```bash
git switch -c typedrat/m2-1a-modules-and-engines master
```

Expected: `Switched to a new branch 'typedrat/m2-1a-modules-and-engines'`.

- [ ] **Step 2: Move the registry's file**

```bash
nix develop -c git mv packages/core/src/services/engines.ts packages/core/src/services/modules.ts
```

- [ ] **Step 3: Rename the identifiers everywhere they appear in code**

`\b` keeps `mkEngineManifest` (which `EngineManifest` follows without a word boundary) and `engineManifest` untouched; `EngineRegistry` has no boundary so that `makeEngineRegistry`, `EngineRegistryOptions` and `EngineRegistryService` follow it, and so does the service key string `"@ibus-web/core/EngineRegistry"`.

```bash
nix develop -c sh -c "git grep -l -E 'EngineManifest|EngineRegistry|EngineSnapshot|EngineState|EngineEvent|enginestate|services/engines\.ts' -- packages tools examples \
  | xargs sed -i -E \
    -e 's/\bdecodeEngineManifest\b/decodeModuleManifest/g' \
    -e 's/\bEngineManifest\b/ModuleManifest/g' \
    -e 's/EngineRegistry/ModuleRegistry/g' \
    -e 's/\bEngineSnapshot\b/ModuleSnapshot/g' \
    -e 's/\bEngineState\b/ModuleState/g' \
    -e 's/\bEngineEvent\b/ModuleEvent/g' \
    -e 's/enginestate/modulestate/g' \
    -e 's#services/engines\.ts#services/modules.ts#g'"
```

- [ ] **Step 4: Rename `engine` to `module` where it names the registry key**

In these files every whole word `engine` is the registry key (the request classes are `CreateEngine`/`DestroyEngine`, which `\b` skips), so a file-wide substitution is exact:

```bash
nix develop -c sed -i -E 's/\bengine\b/module/g' \
  packages/core/src/router/router.ts \
  packages/core/src/router/contexts.ts \
  packages/core/src/services/logging.ts \
  packages/core/src/settings/api.ts \
  packages/ibus-web/src/index.ts \
  packages/panel/src/host.ts \
  packages/panel/src/panel.ts
nix develop -c sed -i -E \
  -e 's/options\.engines/options.modules/g' \
  -e 's/readonly engines: Readonly/readonly modules: Readonly/' \
  -e 's/\bengines: options\.modules/modules: options.modules/g' \
  packages/core/src/services/modules.ts packages/core/src/settings/api.ts packages/ibus-web/src/index.ts
nix develop -c sed -i -E \
  -e 's/\bengine: /module: /g' \
  -e 's/Unknown engine/Unknown module/g' \
  -e 's/`Engine \$\{name\}/`Module ${name}/g' \
  -e 's/readonly engine: string/readonly module: string/g' \
  packages/core/src/services/modules.ts
nix develop -c sed -i 's/Engine surface teardown failed/Module surface teardown failed/' packages/core/src/router/router.ts
```

In `packages/protocol/src/messages/panel.ts`, edit by hand (its first comment says "sends its engine", which must stay):

```ts
// before
interface PanelContext {
  readonly engine: string;
  readonly ic: number;
}
```

```ts
// after
interface PanelContext {
  readonly module: string;
  readonly ic: number;
}
```

and

```ts
// before
// What the page hears for an engine's input context: a record to draw, or
```

```ts
// after
// What the page hears for an input context of a module: a record to draw, or
```

In `examples/hangul/src/main.ts`, rename the facade option:

```bash
nix develop -c sed -i 's/engines: { hangul:/modules: { hangul:/' examples/hangul/src/main.ts
```

- [ ] **Step 5: Rename the same keys in the tests**

```bash
nix develop -c sed -i -E 's/\bengines: \{/modules: {/g' \
  packages/core/test/browser/real-host.ts \
  packages/core/test/browser/settings.test.ts \
  packages/core/test/browser/support/dom.ts \
  packages/core/test/node/router/services.test.ts \
  packages/ibus-web/test/browser/facade.test.ts
nix develop -c sed -i -E 's/\bengine: "test"/module: "test"/g' \
  packages/core/test/node/router/services.test.ts \
  packages/core/test/node/connection/connection.test.ts \
  packages/ibus-web/test/browser/facade.test.ts \
  packages/panel/test/browser/panel.test.ts
```

(`engines: {` in these tests is always the registry, settings or facade option; manifests' `engines` are arrays. `packages/worker-host/test/node/config.ts` keeps its own `engines: {` map of test distributions.)

- [ ] **Step 6: Rename them in the docs**

```bash
nix develop -c sed -i -E \
  -e 's/\bdecodeEngineManifest\b/decodeModuleManifest/g' \
  -e 's/\bEngineManifest\b/ModuleManifest/g' \
  -e 's/EngineRegistry/ModuleRegistry/g' \
  -e 's/enginestate/modulestate/g' \
  -e 's/an `ModuleManifest`/a `ModuleManifest`/g' \
  -e 's/an `modulestate`/a `modulestate`/g' \
  docs/core.md docs/engines.md docs/ibus-web.md docs/known-gaps.md docs/protocol.md docs/worker-host.md \
  docs/specs/2026-09-26-ibus-web-design.md
nix develop -c sed -i -E \
  -e 's/\((engine)\)/(module)/g' \
  -e 's/\(engine, /(module, /g' \
  -e 's/`unload\(name\)`/`unload(module)`/' \
  docs/ibus-web.md docs/specs/2026-09-26-ibus-web-design.md
nix develop -c sed -i -E 's/^(\s*)engines: \{ hangul:/\1modules: { hangul:/' \
  docs/ibus-web.md docs/panel.md packages/ibus-web/README.md packages/engines/hangul/README.md packages/runtime/README.md
```

Then edit by hand.

`docs/core.md`:

```markdown
<!-- before -->
Provide `Router.Default` with `ModuleRegistry.layer({ hostUrl, runtimeUrl, engines })`,
then provide `CoreConfig.Default`, `SettingsSource.Default`, `Logger.Default` and
`PanelEvents.Default`. Registry keys in `engines` map to manifest URLs; they need
not equal the manifest's name or instance engine name. `runtimeUrl` names
```

```markdown
<!-- after -->
Provide `Router.Default` with `ModuleRegistry.layer({ hostUrl, runtimeUrl, modules })`,
then provide `CoreConfig.Default`, `SettingsSource.Default`, `Logger.Default` and
`PanelEvents.Default`. Keys in `modules` name modules and map to their manifest URLs;
they need not equal the manifest's name or any engine's name. `runtimeUrl` names
```

```markdown
<!-- before -->
`router.select(name)` selects the page engine; `router.override(adapter, name)`
```

```markdown
<!-- after -->
`router.select(module)` selects the page's module; `router.override(adapter, module)`
```

```markdown
<!-- before -->
`ModuleRegistry.request(name, request, ic)` already applies its reply records to
```

```markdown
<!-- after -->
`ModuleRegistry.request(module, request, ic)` already applies its reply records to
```

`docs/ibus-web.md`:

```markdown
<!-- before -->
operation. Options are `hostUrl?: URL`, required `runtimeUrl: URL`, required
`engines: Record<string, URL>`, optional `settings: SettingsSourceService`,
```

```markdown
<!-- after -->
operation. Options are `hostUrl?: URL`, required `runtimeUrl: URL`, required
`modules: Record<string, URL>` (each module's manifest, under a name the page
chooses), optional `settings: SettingsSourceService`,
```

`docs/panel.md`:

```markdown
<!-- before -->
The host's `panel` CustomEvents carry an engine, input-context ID and a tagged
```

```markdown
<!-- after -->
The host's `panel` CustomEvents carry a module, input-context ID and a tagged
```

`docs/specs/2026-09-26-ibus-web-design.md` (§7.4.1):

```ts
// before
  engines: Record<string, URL>; // name → manifest URL
```

```ts
// after
  modules: Record<string, URL>; // module → manifest URL
```

- [ ] **Step 7: Check that nothing of the old names is left**

```bash
nix develop -c git grep -n -w -E 'EngineManifest|decodeEngineManifest|EngineRegistry|makeEngineRegistry|EngineRegistryOptions|EngineRegistryService|EngineSnapshot|EngineState|EngineEvent|enginestate' -- packages tools examples docs README.md ':!docs/plans'
nix develop -c git grep -n -E '\bengines: \{' -- packages/core packages/ibus-web packages/panel examples docs/*.md packages/ibus-web/README.md packages/engines/hangul/README.md packages/runtime/README.md
nix develop -c git grep -n -E 'readonly engine: string|\bengine: "test"' -- packages/core packages/protocol/src packages/panel packages/ibus-web
```

Expected: all three print nothing. `docs/specs/2026-10-08-m2-1-table-engine.md` only uses the new names.

- [ ] **Step 8: Format, build the workspace and type-check**

```bash
nix develop -c oxfmt $(git diff --name-only -- '*.ts' '*.md' | grep -v '^docs/plans/')
nix develop -c pnpm -r run build
nix develop -c hk check --all -S tsc
```

Expected: oxfmt finishes; the build succeeds; `✔ tsc`. A tsc error naming an `engine` property means a call site Step 4 or 5 didn't reach: rename it to `module` (it is the registry key) and run the check again.

- [ ] **Step 9: Run the checks covering the rename**

```bash
nix build -L .#checks.x86_64-linux.protocol-node .#checks.x86_64-linux.tools-engine-manifest \
  .#checks.x86_64-linux.core-node .#checks.x86_64-linux.core-browser .#checks.x86_64-linux.panel-browser \
  .#checks.x86_64-linux.ibus-web-browser .#checks.x86_64-linux.worker-host-node .#checks.x86_64-linux.example-hangul-smoke
```

Expected: every check builds (all tests pass). `exports.test.ts` now asserts `api.ModuleRegistry.key` is `"@ibus-web/core/ModuleRegistry"`.

- [ ] **Step 10: Commit**

First check `git status`: every change under `packages`, `tools`, `examples` and `docs` must be this task's (the move from Step 2 is already staged). If someone else's work is there, list this task's paths by hand instead of using the `git diff` lists.

```bash
nix develop -c git add $(git diff --name-only -- packages tools examples docs)
nix develop -c git commit -m "refactor: name the page side's registry keys modules" -- \
  $(git diff --cached --name-only -- packages tools examples docs)
```

Expected: hk's pre-commit hook passes; the commit records the rename of `services/engines.ts` to `services/modules.ts`.

---

### Task 2: Describe each engine of a module in its manifest

`ModuleManifest.engines` becomes a non-empty list of `EngineDescriptor`s with unique names, and the module-level `keyboard` goes. `mkEngineManifest` takes the descriptors as a Nix list or a JSON file. The registry keeps each engine's keyboard policy, every input context records the engine it created, and the key path follows the context's engine. The router still creates the module's first engine; Task 3 lets it choose.

**Files:**

- Modify: `packages/protocol/src/manifest.ts`, `packages/protocol/src/index.ts`
- Test: `packages/protocol/test/engine/manifest.test.ts`
- Modify: `modules/engines/manifest.nix`, `modules/engines/options.nix`, `engines/hangul/module.nix`, `packages/worker-host/module.nix`
- Modify: `packages/core/src/router/keystroke.ts`, `packages/core/src/router/contexts.ts`, `packages/core/src/router/router.ts`, `packages/core/src/services/modules.ts`, `packages/core/src/page/index.ts`
- Test: `packages/core/test/shared/router.ts`, `packages/core/test/node/router/{keystroke,async,services}.test.ts`, `packages/core/test/node/connection/connection.test.ts`, `packages/core/test/browser/{async,settings}.test.ts`, `packages/core/test/browser/support/dom.ts`, `packages/ibus-web/test/browser/facade.test.ts`, `packages/worker-host/test/node/{archive,install-lifetime,startup,storage-plan}.test.ts`
- Modify (docs): `docs/engines.md`, `docs/core.md`, `docs/protocol.md`, `docs/specs/2026-09-26-ibus-web-design.md`

**Interfaces:**

- Consumes: Task 1's names.
- Produces:
  - `@ibus-web/protocol`: `EngineDescriptor` (schema and type, exported from the package root beside `ModuleManifest`), `ModuleManifest.engines: readonly EngineDescriptor[]`; no `ModuleManifest.keyboard`.
  - `@ibus-web/core`: `interface KeyboardPolicy { readonly layout: "us" | "default"; readonly passThrough: ReadonlySet<number> }` (exported); `ModuleSnapshot.keyboards: ReadonlyMap<string, KeyboardPolicy>` (by engine name, empty until the manifest loads) replacing `keyboard` and `passThrough`; `KeyContext.engine: string` (readonly); `InputContext` constructor option and field `engine: string`.
  - Nix: `ibusWeb.engines.mkEngineManifest { name, package, threads, heapBytes, settingsSchemaDir, engines, settingsSchemas }` where `engines` is a list of descriptor attrsets or a path/derivation of a JSON array.

- [ ] **Step 1: Write the failing protocol tests**

Replace `packages/protocol/test/engine/manifest.test.ts` with:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { describe, expect, test } from "vitest";
import { decodeModuleManifest } from "../../src/manifest.ts";

const bounds = { minimum: 32 * 1024 * 1024, maximum: 2 ** 31 };
const storePath = "/nix/store/0123456789abcdfghijklmnpqrsvwxyz-hangul-data";
const engine = {
  name: "hangul",
  displayName: "Hangul",
  languages: ["ko"],
  keyboard: { layout: "us", passThrough: [] },
};
const valid = {
  name: "hangul",
  version: "1",
  license: "GPL-2.0-or-later",
  runtimeAbi: 1,
  protocol: 1,
  module: { url: "./hangul.wasm", size: 1024 },
  memory: bounds.minimum,
  threads: 0,
  data: [{ storePath, url: "./data/hangul.tar.br", size: 4096, encoding: "br" }],
  settingsSchemaDir: `${storePath}/share/glib-2.0/schemas`,
  engines: [engine],
  settingsSchemas: ["org.freedesktop.ibus.engine.hangul"],
};

describe("module manifests", () => {
  test("decodes a valid manifest", () => expect(decodeModuleManifest(valid, bounds)).toEqual(valid));
  test("accepts identity archives", () =>
    expect(
      decodeModuleManifest({ ...valid, data: [{ ...valid.data[0], encoding: "identity" }] }, bounds),
    ).toBeDefined());
  test("requires each engine's keyboard", () => {
    const { keyboard: _, ...missing } = engine;
    expect(() => decodeModuleManifest({ ...valid, engines: [missing] }, bounds)).toThrow();
  });
  test("rejects unknown layout", () =>
    expect(() =>
      decodeModuleManifest({ ...valid, engines: [{ ...engine, keyboard: { layout: "de", passThrough: [] } }] }, bounds),
    ).toThrow());
  test("rejects a keyboard outside the engines", () =>
    expect(() => decodeModuleManifest({ ...valid, keyboard: engine.keyboard }, bounds)).toThrow());
  test("requires the version", () => {
    const { version: _, ...missing } = valid;
    expect(() => decodeModuleManifest(missing, bounds)).toThrow();
  });
  test.each([undefined, "gzip"])("rejects encoding %s", (encoding) => {
    expect(() => decodeModuleManifest({ ...valid, data: [{ ...valid.data[0], encoding }] }, bounds)).toThrow();
  });
  test.each([bounds.minimum - 65536, bounds.maximum + 65536, bounds.minimum + 1])("rejects memory %s", (memory) => {
    expect(() => decodeModuleManifest({ ...valid, memory }, bounds)).toThrow();
  });
  test("uses the supplied runtime minimum", () =>
    expect(() => decodeModuleManifest(valid, { ...bounds, minimum: bounds.minimum * 2 })).toThrow());
  test.each([-1, 0.5])("rejects threads %s", (threads) =>
    expect(() => decodeModuleManifest({ ...valid, threads }, bounds)).toThrow(),
  );
  test.each(["/usr/share/hangul", `${storePath}/nested`, "/nix/store/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-data"])(
    "rejects store path %s",
    (path) => {
      expect(() => decodeModuleManifest({ ...valid, data: [{ ...valid.data[0], storePath: path }] }, bounds)).toThrow();
    },
  );
  test("rejects duplicate store paths", () =>
    expect(() => decodeModuleManifest({ ...valid, data: [...valid.data, ...valid.data] }, bounds)).toThrow());
  test.each(["/usr/share/schemas", `${storePath}-other/schemas`, `${storePath}/../schemas`])(
    "rejects schema directory %s",
    (settingsSchemaDir) => {
      expect(() => decodeModuleManifest({ ...valid, settingsSchemaDir }, bounds)).toThrow();
    },
  );
  test.each(["", ".", "..", "a/b", "/hangul", ".hidden", "-hangul", "han gul", "hangul\0", "한글"])(
    "rejects name %j",
    (name) => expect(() => decodeModuleManifest({ ...valid, name }, bounds)).toThrow(),
  );
  test.each(["hangul", "Hangul2", "m17n.ko", "chewing-plus", "x_y+z", "a..b"])("accepts name %j", (name) =>
    expect(decodeModuleManifest({ ...valid, name }, bounds).name).toBe(name),
  );
  test("rejects an empty license", () =>
    expect(() => decodeModuleManifest({ ...valid, license: "" }, bounds)).toThrow());
  test("rejects an empty module url", () =>
    expect(() => decodeModuleManifest({ ...valid, module: { ...valid.module, url: "" } }, bounds)).toThrow());
  test("rejects an empty data url", () =>
    expect(() => decodeModuleManifest({ ...valid, data: [{ ...valid.data[0], url: "" }] }, bounds)).toThrow());
  test("requires at least one engine", () =>
    expect(() => decodeModuleManifest({ ...valid, engines: [] }, bounds)).toThrow());
  test.each(["name", "displayName"])("rejects an empty engine %s", (field) =>
    expect(() => decodeModuleManifest({ ...valid, engines: [{ ...engine, [field]: "" }] }, bounds)).toThrow(),
  );
  test("rejects duplicate engine names", () =>
    expect(() =>
      decodeModuleManifest({ ...valid, engines: [engine, { ...engine, displayName: "Other" }] }, bounds),
    ).toThrow());
  test("keeps several engines in order, the first being the default", () =>
    expect(
      decodeModuleManifest({ ...valid, engines: [engine, { ...engine, name: "romaja" }] }, bounds).engines.map(
        (descriptor) => descriptor.name,
      ),
    ).toEqual(["hangul", "romaja"]));
  test.each([
    ["the manifest", { ...valid, extra: 1 }],
    ["the module", { ...valid, module: { ...valid.module, extra: 1 } }],
    ["a data entry", { ...valid, data: [{ ...valid.data[0], extra: 1 }] }],
    ["an engine", { ...valid, engines: [{ ...engine, extra: 1 }] }],
  ])("rejects an excess key in %s", (_, manifest) => expect(() => decodeModuleManifest(manifest, bounds)).toThrow());
  test.each([`${storePath}//schemas`, `${storePath}/share/`, `${storePath}/`, `${storePath}/share//`])(
    "rejects schema directory %s with an empty component",
    (settingsSchemaDir) => expect(() => decodeModuleManifest({ ...valid, settingsSchemaDir }, bounds)).toThrow(),
  );
});

test("accepts an optional settings metadata asset and validates its size and URL", () => {
  const settingsMetadata = { url: "./settings.json", size: 200 };
  expect(decodeModuleManifest({ ...valid, settingsMetadata }, bounds).settingsMetadata).toEqual(settingsMetadata);
  for (const asset of [
    { url: "", size: 200 },
    { url: "./settings.json", size: -1 },
  ])
    expect(() => decodeModuleManifest({ ...valid, settingsMetadata: asset }, bounds)).toThrow();
});
```

- [ ] **Step 2: Run them to see them fail**

```bash
nix develop -c pnpm --dir packages/protocol test test/engine/manifest.test.ts
```

Expected: FAIL, among others `decodes a valid manifest` (an engine descriptor isn't a non-empty string) and `rejects duplicate engine names` (nothing rejects them).

- [ ] **Step 3: Add `EngineDescriptor` to the manifest schema**

Replace `packages/protocol/src/manifest.ts` with:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Schema } from "effect";
import { nonEmpty } from "./schemas.ts";

const count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
// The name becomes a directory and a database name, so it must be one path component that can't
// climb out of its parent or hide itself.
const moduleName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/));
const storePath = Schema.String.check(
  Schema.isPattern(/^\/nix\/store\/[0-9abcdfghijklmnpqrsvwxyz]{32}-[A-Za-z0-9+._?=-]+$/),
);

export const EngineDescriptor = Schema.Struct({
  name: nonEmpty,
  displayName: nonEmpty,
  languages: Schema.Array(Schema.String),
  keyboard: Schema.Struct({ layout: Schema.Literals(["us", "default"]), passThrough: Schema.Array(Schema.String) }),
});

export type EngineDescriptor = typeof EngineDescriptor.Type;

export const ModuleManifest = Schema.Struct({
  name: moduleName,
  version: nonEmpty,
  license: nonEmpty,
  runtimeAbi: count,
  protocol: count,
  module: Schema.Struct({ url: nonEmpty, size: count }),
  memory: count.check(Schema.isMultipleOf(65536)),
  threads: count,
  data: Schema.Array(
    Schema.Struct({
      storePath,
      url: nonEmpty,
      size: count,
      encoding: Schema.Literals(["br", "identity"]),
    }),
  ),
  settingsSchemaDir: Schema.String,
  // The first engine is the module's default.
  engines: Schema.Array(EngineDescriptor).check(Schema.isNonEmpty()),
  settingsSchemas: Schema.Array(Schema.String),
  settingsMetadata: Schema.optionalKey(Schema.Struct({ url: nonEmpty, size: count })),
}).check(
  Schema.makeFilter((manifest) => {
    const names = manifest.engines.map((engine) => engine.name);
    if (new Set(names).size !== names.length) return "duplicate engine names";

    const paths = manifest.data.map((entry) => entry.storePath);
    if (new Set(paths).size !== paths.length) return "duplicate data store paths";
    const components = manifest.settingsSchemaDir.split("/").slice(1);
    if (components.some((component) => component === "" || component === "." || component === ".."))
      return "schema directory must be a canonical store path";
    return (
      paths.some((path) => manifest.settingsSchemaDir.startsWith(`${path}/`)) ||
      "schema directory is outside the data closure"
    );
  }),
);

export type ModuleManifest = typeof ModuleManifest.Type;

export const decodeModuleManifest = (
  json: unknown,
  bounds: { readonly minimum: number; readonly maximum: number },
): ModuleManifest =>
  Schema.decodeUnknownSync(
    ModuleManifest.check(
      Schema.makeFilter(
        (manifest) =>
          (manifest.memory >= bounds.minimum && manifest.memory <= bounds.maximum) ||
          "memory is outside the runtime bounds",
      ),
    ),
    // A misspelled key would otherwise be dropped silently and its field read as missing or default.
    { onExcessProperty: "error" },
  )(json);
```

In `packages/protocol/src/index.ts`:

```ts
// before
export { ModuleManifest, decodeModuleManifest } from "./manifest.ts";
```

```ts
// after
export { EngineDescriptor, ModuleManifest, decodeModuleManifest } from "./manifest.ts";
```

- [ ] **Step 4: Run the protocol tests to see them pass**

```bash
nix develop -c pnpm --dir packages/protocol test test/engine/manifest.test.ts
```

Expected: PASS (54 tests).

- [ ] **Step 5: Let `mkEngineManifest` take descriptors**

In `modules/engines/manifest.nix`, drop `keyboard` from the arguments:

```nix
# before
        {
          name,
          keyboard,
          package,
```

```nix
# after
        {
          name,
          package,
```

then replace the `licenses`/`description` bindings:

```nix
# before
          licenses = lib.toList package.meta.license;
          description = pkgs.writeText "ibus-web-${name}-manifest-fields.json" (
            builtins.toJSON {
              inherit
                name
                keyboard
                threads
                settingsSchemaDir
                engines
                settingsSchemas
                ;
```

```nix
# after
          licenses = lib.toList package.meta.license;

          # Descriptors can come from another derivation's build; the check below
          # validates them with the rest of the manifest, so evaluation never reads them.
          enginesFile =
            if builtins.isList engines then
              pkgs.writeText "ibus-web-${name}-engines.json" (builtins.toJSON engines)
            else
              engines;

          description = pkgs.writeText "ibus-web-${name}-manifest-fields.json" (
            builtins.toJSON {
              inherit
                name
                threads
                settingsSchemaDir
                settingsSchemas
                ;
```

and add the descriptors to the `jq` that writes `manifest.json`:

```nix
# before
              --slurpfile data data.jsonl \
              '.version += "+nix." + $identity | . + { $runtimeAbi, $protocol, $memory, module: { $url, $size }, $data, $settingsMetadata }' \
```

```nix
# after
              --slurpfile data data.jsonl --slurpfile engines ${enginesFile} \
              '.version += "+nix." + $identity | . + { $runtimeAbi, $protocol, $memory, module: { $url, $size }, $data, engines: $engines[0], $settingsMetadata }' \
```

In `modules/engines/options.nix`, extend `mkEngineManifest`'s description:

```nix
# before
        links stored as files; the build fails if a symbolic link in the closure leads outside it.
      '';
```

```nix
# after
        links stored as files; the build fails if a symbolic link in the closure leads outside it.
        `engines` lists the module's engine descriptors, the first being its default, either as Nix
        attribute sets or as a JSON file holding the array.
      '';
```

- [ ] **Step 6: Give Hangul and the host's test distributions their descriptors**

In `engines/hangul/module.nix`, inside `packages.ibus-web-hangul-dist = engines.mkEngineManifest { … }`:

```nix
# before
        name = "hangul";
        keyboard = {
          layout = "us";
          passThrough = [ ];
        };
        package = hangul;
```

```nix
# after
        name = "hangul";
        package = hangul;
```

```nix
# before
        engines = [ "hangul" ];
```

```nix
# after
        engines = [
          {
            name = "hangul";
            displayName = "Hangul";
            languages = [ "ko" ];
            keyboard = {
              layout = "us";
              passThrough = [ ];
            };
          }
        ];
```

In `packages/worker-host/module.nix`, add a descriptor helper after `engineSides` and use it in both calls:

```nix
# before
        empty = engineSide "empty" "engine-empty.c";
      };
      engineDists = lib.mapAttrs (
        name: package:
        engines.mkEngineManifest {
          keyboard = {
            layout = "default";
            passThrough = [ ];
          };
          inherit name package settingsSchemaDir;
          threads = engineThreads;
          heapBytes = 1024 * 1024;
          engines = [ name ];
```

```nix
# after
        empty = engineSide "empty" "engine-empty.c";
      };
      testEngine = name: {
        inherit name;
        displayName = name;
        languages = [ ];
        keyboard = {
          layout = "default";
          passThrough = [ ];
        };
      };
      engineDists = lib.mapAttrs (
        name: package:
        engines.mkEngineManifest {
          inherit name package settingsSchemaDir;
          threads = engineThreads;
          heapBytes = 1024 * 1024;
          engines = [ (testEngine name) ];
```

```nix
# before
      rebuiltDist = engines.mkEngineManifest {
        keyboard = {
          layout = "default";
          passThrough = [ ];
        };
        name = "empty";
```

```nix
# after
      rebuiltDist = engines.mkEngineManifest {
        name = "empty";
```

```nix
# before
        engines = [ "empty" ];
```

```nix
# after
        engines = [ (testEngine "empty") ];
```

Then rewrite the literal manifests in the host's Node tests (each has `engines: ["<x>"],` followed by the `keyboard` line):

```bash
nix develop -c perl -0pi -e 's/engines: \["([^"]+)"\],\n\s*keyboard: \{ layout: "us", passThrough: \[\] \},/engines: [{ name: "$1", displayName: "$1", languages: [], keyboard: { layout: "us", passThrough: [] } }],/g' \
  packages/worker-host/test/node/archive.test.ts packages/worker-host/test/node/install-lifetime.test.ts \
  packages/worker-host/test/node/startup.test.ts packages/worker-host/test/node/storage-plan.test.ts
```

- [ ] **Step 7: Build Hangul's distribution and read its descriptors**

```bash
nix build .#ibus-web-hangul-dist
jq -c '{ engines, keyboard }' result/manifest.json
rm result
```

Expected: `{"engines":[{"displayName":"Hangul","keyboard":{"layout":"us","passThrough":[]},"languages":["ko"],"name":"hangul"}],"keyboard":null}`. The build itself ran `tools/engine-manifest/protocol.ts check`, so the new schema accepted it.

- [ ] **Step 8: Keep keyboard policy per engine in core**

`packages/core/src/router/keystroke.ts`:

```ts
// before
export interface ModuleSnapshot {
  readonly name: string;
  manifest?: ModuleManifest;
  status: ModuleState;
  enabled: boolean;
  generation: number;
  connection: KeyConnection | undefined;
  keyboard: ModuleManifest["keyboard"];
  passThrough: ReadonlySet<number>;
}
/** apply and consumed run inside the adapter transaction and must only do synchronous work. */
export interface KeyContext {
  readonly ic: number;
```

```ts
// after
export interface KeyboardPolicy {
  readonly layout: "us" | "default";
  readonly passThrough: ReadonlySet<number>;
}
export interface ModuleSnapshot {
  readonly name: string;
  manifest?: ModuleManifest;
  status: ModuleState;
  enabled: boolean;
  generation: number;
  connection: KeyConnection | undefined;
  /** By engine name; empty until the manifest has loaded. */
  keyboards: ReadonlyMap<string, KeyboardPolicy>;
}
/** apply and consumed run inside the adapter transaction and must only do synchronous work. */
export interface KeyContext {
  readonly ic: number;
  /** The engine created in this context, whose keyboard policy its keys follow. */
  readonly engine: string;
```

```ts
// before
    const translated = translateKey(event, snapshot.keyboard.layout);
    if (!translated || snapshot.passThrough.has(translated.keyval)) return undefined;
```

```ts
// after
    const keyboard = snapshot.keyboards.get(context.engine);
    if (!keyboard) return undefined;
    const translated = translateKey(event, keyboard.layout);
    if (!translated || keyboard.passThrough.has(translated.keyval)) return undefined;
```

`packages/core/src/router/contexts.ts`:

```ts
// before
  readonly ic: number;
  readonly module: string;
  generation: number;
```

```ts
// after
  readonly ic: number;
  readonly module: string;
  readonly engine: string;
  generation: number;
```

```ts
// before
    ic: number;
    module: string;
    generation: number;
```

```ts
// after
    ic: number;
    module: string;
    engine: string;
    generation: number;
```

```ts
// before
    this.module = options.module;
```

```ts
// after
    this.module = options.module;
    this.engine = options.engine;
```

`packages/core/src/router/router.ts` (the module's first engine until Task 3):

```ts
// before
          ic: surface.ic,
          module,
          generation: snapshot.generation,
```

```ts
// after
          ic: surface.ic,
          module,
          engine: snapshot.manifest!.engines[0]!.name,
          generation: snapshot.generation,
```

```ts
// before
        const reply = yield* request(context, new CreateEngine({ name: snapshot.manifest!.engines[0]! }));
```

```ts
// after
        const reply = yield* request(context, new CreateEngine({ name: context.engine }));
```

`packages/core/src/services/modules.ts`:

```ts
// before
import {
  KeyRouter,
  type ModuleSnapshot,
```

```ts
// after
import {
  KeyRouter,
  type KeyboardPolicy,
  type ModuleSnapshot,
```

```ts
// before
  /** Public registry keys may differ from both manifest.name and manifest.engines. */
```

```ts
// after
  /** Keys name modules; they may differ from manifest.name and from every engine's name. */
```

```ts
// before
  /\b(?:RuntimeAbiMismatch|ProtocolMismatch):|manifest \(memory bounds /.test(cause.message);
```

```ts
// after
  /\b(?:RuntimeAbiMismatch|ProtocolMismatch):|manifest \(memory bounds /.test(cause.message);
const keyboards = (manifest: ModuleManifest): Map<string, KeyboardPolicy> =>
  new Map(
    manifest.engines.map(({ name, keyboard }) => [
      name,
      { layout: keyboard.layout, passThrough: new Set(keyboard.passThrough.map((key) => keysymByName.get(key)!)) },
    ]),
  );
```

```ts
// before
          yield* Effect.try({ try: () => validateKeyboard(manifest.keyboard), catch: asError });
```

```ts
// after
          yield* Effect.try({
            try: () => {
              for (const engine of manifest.engines) validateKeyboard(engine.keyboard);
            },
            catch: asError,
          });
```

```ts
// before
          entry.snapshot.keyboard = manifest.keyboard;
          entry.snapshot.passThrough = new Set(manifest.keyboard.passThrough.map((key) => keysymByName.get(key)!));
```

```ts
// after
          entry.snapshot.keyboards = keyboards(manifest);
```

```ts
// before
        keyboard: { layout: "default", passThrough: [] },
        passThrough: new Set(),
```

```ts
// after
        keyboards: new Map(),
```

`packages/core/src/page/index.ts`:

```ts
// before
  KeyRouter,
  type ModuleSnapshot,
```

```ts
// after
  KeyRouter,
  type KeyboardPolicy,
  type ModuleSnapshot,
```

- [ ] **Step 9: Update the core and facade fixtures**

Literal manifests (each has a `keyboard` line near the top and `engines: ["<x>"]` lower down):

```bash
nix develop -c perl -0pi -e 's/\n\s*keyboard: \{ layout: "us", passThrough: \[\] \},//; s/engines: \["(\w+)"\]/engines: [{ name: "$1", displayName: "$1", languages: [], keyboard: { layout: "us", passThrough: [] } }]/g' \
  packages/core/test/node/router/services.test.ts packages/core/test/browser/settings.test.ts \
  packages/core/test/browser/support/dom.ts packages/ibus-web/test/browser/facade.test.ts
```

`packages/core/test/node/router/services.test.ts`, by hand:

```ts
// before (written by the perl above)
        loadManifest: async () => ({ ...manifest, name: "distribution", engines: [{ name: "factory", displayName: "factory", languages: [], keyboard: { layout: "us", passThrough: [] } }] }),
```

```ts
// after
        loadManifest: async () => ({
          ...manifest,
          name: "distribution",
          engines: [{ ...manifest.engines[0]!, name: "factory" }],
        }),
```

```ts
// before
      loadManifest: async () => ({ ...manifest, keyboard: { layout: "us", passThrough: ["NotAKeysym"] } }),
```

```ts
// after
      loadManifest: async () => ({
        ...manifest,
        engines: [{ ...manifest.engines[0]!, keyboard: { layout: "us", passThrough: ["NotAKeysym"] } }],
      }),
```

```ts
// before
      expect(registry.snapshot("alias")!.manifest!.engines).toEqual(["factory"]);
      yield* Effect.promise(() =>
        registry.request("alias", new CreateEngine({ name: registry.snapshot("alias")!.manifest!.engines[0]! }), 1),
      );
```

```ts
// after
      expect(registry.snapshot("alias")!.manifest!.engines.map((engine) => engine.name)).toEqual(["factory"]);
      yield* Effect.promise(() =>
        registry.request(
          "alias",
          new CreateEngine({ name: registry.snapshot("alias")!.manifest!.engines[0]!.name }),
          1,
        ),
      );
```

`packages/core/test/shared/router.ts`:

```ts
// before
    connection,
    keyboard: { layout: "us", passThrough: [] },
    passThrough: new Set(),
  };
```

```ts
// after
    connection,
    keyboards: new Map([["test", { layout: "us", passThrough: new Set() }]]),
  };
```

```ts
// before
  const context: KeyContext = {
    ic: 1,
```

```ts
// after
  const context: KeyContext = {
    ic: 1,
    engine: "test",
```

The keystroke tests that toggled a module-wide pass-through now toggle the engine's:

```bash
nix develop -c sed -i \
  -e 's/f\.snapshot\.passThrough = new Set(\[97\]);/f.snapshot.keyboards = new Map([["test", { layout: "us" as const, passThrough: new Set([97]) }]]);/' \
  -e 's/f\.snapshot\.passThrough = new Set();/f.snapshot.keyboards = new Map([["test", { layout: "us" as const, passThrough: new Set<number>() }]]);/' \
  packages/core/test/node/router/keystroke.test.ts packages/core/test/node/router/async.test.ts
nix develop -c sed -i \
  -e 's/registry\.snapshot("a")!\.passThrough = new Set(\[97\]);/registry.snapshot("a")!.keyboards = new Map([["factory", { layout: "us" as const, passThrough: new Set([97]) }]]);/' \
  -e 's/registry\.snapshot("a")!\.passThrough = new Set();/registry.snapshot("a")!.keyboards = new Map([["factory", { layout: "us" as const, passThrough: new Set<number>() }]]);/' \
  packages/core/test/browser/async.test.ts
```

`packages/core/test/node/connection/connection.test.ts`, where the test builds an `InputContext`:

```ts
// before
        ic: 7,
        module: "test",
```

```ts
// after
        ic: 7,
        module: "test",
        engine: "test",
```

- [ ] **Step 10: Update the docs**

`docs/engines.md`:

```markdown
<!-- before -->
`ibusWeb.engines.mkEngineManifest` takes `name`, `package`, `threads`,
`heapBytes`, `settingsSchemaDir`, `engines`, `settingsSchemas` and `keyboard`. It derives
```

```markdown
<!-- after -->
`ibusWeb.engines.mkEngineManifest` takes `name`, `package`, `threads`,
`heapBytes`, `settingsSchemaDir`, `engines` and `settingsSchemas`. `engines` is the
module's engine descriptors, as a Nix list or as a JSON file another derivation
builds; the manifest's own check validates them, so evaluation never reads a build
output. It derives
```

```markdown
<!-- before -->
`data/<hash>-<name>.tar.br` per closure store path. `ModuleManifest` in
`@ibus-web/protocol` has these fields:
```

```markdown
<!-- after -->
`data/<hash>-<name>.tar.br` per closure store path. A module is one such
distribution, run in one Worker; its engines are the input methods inside it, each
created by name with `CreateEngine`. `ModuleManifest` and `EngineDescriptor` in
`@ibus-web/protocol` have these fields:
```

In the type block (and the identical block in §5.4.4 of `docs/specs/2026-09-26-ibus-web-design.md`):

```ts
// before
  settingsSchemaDir: string;
  engines: string[];
  settingsSchemas: string[];
  settingsMetadata?: { url: string; size: number };
  keyboard: { layout: "us" | "default"; passThrough: string[] };
};
```

```ts
// after
  settingsSchemaDir: string;
  engines: EngineDescriptor[];
  settingsSchemas: string[];
  settingsMetadata?: { url: string; size: number };
};

type EngineDescriptor = {
  name: string;
  displayName: string;
  languages: string[]; // BCP 47
  keyboard: { layout: "us" | "default"; passThrough: string[] };
};
```

```markdown
<!-- before -->
constructs a metadata-driven form. Hangul's keyboard key has no generated
choices. `keyboard.layout = "us"` translates physical `event.code` positions;
`"default"` uses translated `event.key`. This engine keyboard preference is not
an OS keyboard-layout detector.
```

```markdown
<!-- after -->
constructs a metadata-driven form. Hangul's keyboard key has no generated
choices. An engine's `keyboard.layout = "us"` translates physical `event.code`
positions; `"default"` uses translated `event.key`. This engine keyboard preference
is not an OS keyboard-layout detector. The first engine is the module's default.
Hangul's manifest lists one engine: `hangul`, "Hangul", `["ko"]`, with the US
layout and no pass-through keys.
```

```markdown
<!-- before -->
- `version`, `license` and every URL are non-empty; `engines` lists at least
  one engine, each name non-empty;
```

```markdown
<!-- after -->
- `version`, `license` and every URL are non-empty; `engines` lists at least
  one engine, with non-empty, unique names and non-empty display names;
```

`docs/core.md`:

```markdown
<!-- before -->
`keycode` comes from the evdev column for `event.code`. A required manifest
`keyboard` field declares `{ layout: "us" | "default", passThrough: string[] }`;
pass-through entries are validated keysym names and skip engine processing.
Hangul declares the US layout and an empty pass-through list.
```

```markdown
<!-- after -->
`keycode` comes from the evdev column for `event.code`. Each engine descriptor in
the manifest has a required `keyboard` field, `{ layout: "us" | "default",
passThrough: string[] }`, and a context's keys follow its engine's. Pass-through
entries are validated keysym names and skip engine processing. Hangul declares the
US layout and an empty pass-through list.
```

`docs/protocol.md`:

```markdown
<!-- before -->
`ModuleManifest` and `decodeModuleManifest(json, { minimum, maximum })` decode an
engine's distribution manifest against the runtime's memory bounds, rejecting
```

```markdown
<!-- after -->
`ModuleManifest`, its `EngineDescriptor`s and `decodeModuleManifest(json, { minimum, maximum })`
decode a module's distribution manifest against the runtime's memory bounds, rejecting
```

`docs/specs/2026-09-26-ibus-web-design.md` (§5.4.4, after the type block above):

```markdown
<!-- before -->
itself. `version`, `license` and every URL are non-empty, and `engines` names
at least one engine, each non-empty. Unknown keys are rejected at every
```

```markdown
<!-- after -->
itself. `version`, `license` and every URL are non-empty, and `engines` lists
at least one engine, the first being the module's default, with non-empty and
unique names and non-empty display names. Unknown keys are rejected at every
```

- [ ] **Step 11: Format, type-check and run the checks**

```bash
nix develop -c oxfmt $(git diff --name-only -- '*.ts' '*.md' | grep -v '^docs/plans/')
nix develop -c pnpm -r run build
nix develop -c hk check --all -S tsc -S nixfmt
nix build -L .#checks.x86_64-linux.protocol-node .#checks.x86_64-linux.tools-engine-manifest \
  .#checks.x86_64-linux.core-node .#checks.x86_64-linux.core-browser .#checks.x86_64-linux.ibus-web-browser \
  .#checks.x86_64-linux.worker-host-node .#checks.x86_64-linux.worker-host-browser \
  .#checks.x86_64-linux.worker-host-engine-distribution-identity .#checks.x86_64-linux.hangul-host \
  .#checks.x86_64-linux.engines-settings-metadata .#checks.x86_64-linux.typescript-npm \
  .#checks.x86_64-linux.example-hangul-smoke
```

Expected: `✔ tsc`, `✔ nixfmt`, and every check builds. The worker-host and Hangul host checks load distributions built by the new `mkEngineManifest`; `typescript-npm` packs `@ibus-web/engine-hangul` with the new `manifest.json`.

- [ ] **Step 12: Commit**

```bash
nix develop -c git add packages/protocol modules/engines engines/hangul/module.nix packages/worker-host \
  packages/core packages/ibus-web/test docs/engines.md docs/core.md docs/protocol.md \
  docs/specs/2026-09-26-ibus-web-design.md
nix develop -c git commit -m "feat(protocol): describe each engine of a module in its manifest" -- \
  packages/protocol modules/engines engines/hangul/module.nix packages/worker-host packages/core \
  packages/ibus-web/test docs/engines.md docs/core.md docs/protocol.md docs/specs/2026-09-26-ibus-web-design.md
```

---

### Task 3: Switch engines within a module, deselect, and report the selection

The router's selection becomes `{ module, engine }`. A surface keeps one input context per module; switching engine inside a module drains it and sends `Disable`/`FocusOut` as any switch does, then `DestroyEngine`, and creates the new engine with `CreateEngine{engine}` in the same context and Worker. `deselect()` returns every surface, overrides included, to native input. `registry.engines(module)` reads the manifest without starting a Worker; the facade exposes it with `deselect`, `selection` and `selectionchange`.

**Files:**

- Modify: `packages/core/src/router/router.ts` (rewritten), `packages/core/src/services/modules.ts`, `packages/core/src/page/index.ts`
- Modify: `packages/ibus-web/src/index.ts`
- Test: `packages/core/test/browser/router/switching.test.ts`, `packages/core/test/browser/support/dom.ts`, `packages/core/test/node/router/services.test.ts`, `packages/ibus-web/test/browser/facade.test.ts`
- Modify (docs): `docs/core.md`, `docs/ibus-web.md`, `docs/specs/2026-09-26-ibus-web-design.md`

**Interfaces:**

- Consumes: Task 2's `EngineDescriptor`, `ModuleSnapshot.keyboards`, `KeyContext.engine`, `InputContext({ …, engine })`.
- Produces:
  - `ModuleRegistryService.engines(name: string): Effect.Effect<readonly EngineDescriptor[], Error>`: reads and validates the manifest (shared with Worker start-up; a failed read is retried), starts no Worker, marks a not-yet-started module `failed` when the read fails, and fails with `Unknown module: <name>` for an unknown key.
  - `@ibus-web/core` exports `interface Selection { readonly module: string; readonly engine: string }`.
  - `RouterService`: `select(module: string, engine?: string)`, `deselect()`, `unload(module)`, `override(adapter, selection: { readonly module: string; readonly engine?: string } | undefined)`, `activeContext(): { module; engine; ic; adapter } | undefined`, `readonly selection: Selection | undefined`, `readonly selectionChanges: Stream.Stream<Selection | undefined>`. Errors: `Unknown module: <m>`, `Unknown engine: <e> in module <m>`.
  - `ibus-web`: `IbusWeb.select(module, engine?)`, `deselect()`, `engines(module): Promise<EngineDescriptor[]>`, `readonly selection: Selection | undefined`, event `selectionchange: CustomEvent<Selection | null>`; `ibus-web` re-exports the types `Selection` and `EngineDescriptor`.

- [ ] **Step 1: Give the fake host's module two engines**

In `packages/core/test/browser/support/dom.ts`, replace the manifest's `engines` entry:

```ts
// before
  engines: [{ name: "factory", displayName: "factory", languages: [], keyboard: { layout: "us", passThrough: [] } }],
```

```ts
// after
  // The second engine passes `a` through, so a test can tell whose keyboard policy applies.
  engines: [
    { name: "factory", displayName: "Factory", languages: [], keyboard: { layout: "us", passThrough: [] } },
    { name: "other", displayName: "Other", languages: [], keyboard: { layout: "us", passThrough: ["a"] } },
  ],
```

- [ ] **Step 2: Write the failing router tests**

In `packages/core/test/browser/router/switching.test.ts`, import `Fiber` and `Stream`:

```ts
// before
import { Effect } from "effect";
```

```ts
// after
import { Effect, Fiber, Stream } from "effect";
```

give the existing override test the new argument:

```ts
// before
    await Effect.runPromise(router.override(f.adapter, "a"));
```

```ts
// after
    await Effect.runPromise(router.override(f.adapter, { module: "a" }));
```

and insert these tests before `test("hotkeys start empty, can consume a custom binding, and unregister", …)`:

```ts
test("switching engine within a module reuses its Worker and destroys the old engine first", () =>
  run(async ({ router, connections, field }) => {
    const f = field();
    f.element.focus();
    await select(router);
    const a = connections.a[0]!;
    a.outcome = { _tag: "reply", ret: 1, records: [preedit()] };
    key(f.element);
    await Effect.runPromise(router.select("a", "other"));
    expect(f.element.value).toBe("한");
    expect(connections.a).toHaveLength(1);
    expect(
      a.sent
        .map((x) => x.request._tag)
        .filter((tag) => ["CreateEngine", "DestroyEngine", "Enable", "Disable", "FocusIn", "FocusOut"].includes(tag)),
    ).toEqual([
      "CreateEngine",
      "Enable",
      "FocusIn",
      "Disable",
      "FocusOut",
      "DestroyEngine",
      "CreateEngine",
      "Enable",
      "FocusIn",
    ]);
    expect(a.sent.flatMap(({ request }) => (request._tag === "CreateEngine" ? [request.name] : []))).toEqual([
      "factory",
      "other",
    ]);
    expect(router.selection).toEqual({ module: "a", engine: "other" });
    expect(router.activeContext()).toMatchObject({ module: "a", engine: "other", adapter: f.adapter });
  }));
test("the keyboard policy follows the selected engine", () =>
  run(async ({ router, connections, field }) => {
    const f = field();
    f.element.focus();
    await select(router);
    connections.a[0]!.outcome = { _tag: "reply", ret: 1, records: [] };
    expect(key(f.element).defaultPrevented).toBe(true);
    await Effect.runPromise(router.select("a", "other"));
    expect(key(f.element).defaultPrevented).toBe(false);
    expect(key(f.element, "b").defaultPrevented).toBe(true);
  }));
test("an unknown module or engine fails without changing the selection or starting a Worker", () =>
  run(async ({ router, connections, field }) => {
    const f = field();
    f.element.focus();
    await select(router);
    await expect(Effect.runPromise(router.select("a", "missing"))).rejects.toThrow(/Unknown engine/);
    await expect(Effect.runPromise(router.select("b", "missing"))).rejects.toThrow(/Unknown engine/);
    await expect(Effect.runPromise(router.select("c"))).rejects.toThrow(/Unknown module/);
    expect(router.selection).toEqual({ module: "a", engine: "factory" });
    expect(connections.b).toHaveLength(0);
    connections.a[0]!.outcome = { _tag: "reply", ret: 1, records: [] };
    expect(key(f.element).defaultPrevented).toBe(true);
  }));
test("deselect finishes the composition and returns surfaces to native input without unloading", () =>
  run(async ({ router, connections, field }) => {
    const f = field();
    f.element.focus();
    await select(router);
    const a = connections.a[0]!;
    a.outcome = { _tag: "reply", ret: 1, records: [preedit()] };
    key(f.element);
    await Effect.runPromise(router.deselect());
    expect(f.element.value).toBe("한");
    expect(router.selection).toBeUndefined();
    expect(a.sent.slice(-2).map((x) => x.request._tag)).toEqual(["Disable", "FocusOut"]);
    expect(key(f.element).defaultPrevented).toBe(false);
    expect(a.terminated).toBe(false);
    await select(router);
    expect(key(f.element).defaultPrevented).toBe(true);
    expect(a.sent.filter((x) => x.request._tag === "CreateEngine")).toHaveLength(1);
  }));
test("an override can name another engine of the module, in its own context on the same Worker", () =>
  run(async ({ router, connections, field }) => {
    const first = field(),
      second = field();
    await Effect.runPromise(router.override(second.adapter, { module: "a", engine: "other" }));
    first.element.focus();
    await select(router);
    second.element.focus();
    await select(router);
    expect(connections.a).toHaveLength(1);
    expect(
      connections.a[0]!.sent.flatMap(({ request, ic }) =>
        request._tag === "CreateEngine" ? [[ic, request.name]] : [],
      ),
    ).toEqual([
      [1, "factory"],
      [2, "other"],
    ]);
    expect(router.activeContext()).toMatchObject({ module: "a", engine: "other", adapter: second.adapter });
    connections.a[0]!.outcome = { _tag: "reply", ret: 1, records: [] };
    expect(key(second.element).defaultPrevented).toBe(false);
    expect(key(second.element, "b").defaultPrevented).toBe(true);
  }));
test("selection changes are published in order", () =>
  run(async ({ router }) => {
    const seen: unknown[] = [];
    const listening = Effect.runFork(
      router.selectionChanges.pipe(Stream.runForEach((selection) => Effect.sync(() => seen.push(selection)))),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Effect.runPromise(router.select("a", "other"));
    await Effect.runPromise(router.select("a", "other"));
    await Effect.runPromise(router.deselect());
    await select(router, "b");
    await expect.poll(() => seen).toHaveLength(3);
    expect(seen).toEqual([{ module: "a", engine: "other" }, undefined, { module: "b", engine: "factory" }]);
    await Effect.runPromise(Fiber.interrupt(listening));
  }));
test("a selection waiting for its module's manifest yields to a later one", () =>
  run(async ({ router }) => {
    await Promise.all([select(router, "b"), select(router, "a")]);
    expect(router.selection).toEqual({ module: "a", engine: "factory" });
  }));
```

- [ ] **Step 3: Write the failing registry tests**

In `packages/core/test/node/router/services.test.ts`, insert before `it.effect(\n  "settings and panel streams publish after synchronous enqueue, and logger maps GLib levels with annotations",`:

```ts
it.effect("registry lists a module's engines without starting its Worker, and starts it on the same read", () =>
  Effect.gen(function* () {
    let reads = 0,
      starts = 0;
    const registry = yield* makeModuleRegistry({
      hostUrl: url,
      runtimeUrl: url,
      modules: { test: url },
      loadManifest: async () => {
        reads++;
        return { ...manifest, engines: [...manifest.engines, { ...manifest.engines[0]!, name: "second" }] };
      },
      start: async () => {
        starts++;
        const connection = new FakeConnection();
        connection.requestAsync = async () => emptyReply;
        return connection;
      },
    });
    expect((yield* registry.engines("test")).map((engine) => engine.name)).toEqual(["test", "second"]);
    expect(starts).toBe(0);
    expect(registry.state("test")).toBe("starting");
    yield* registry.select("test");
    expect(starts).toBe(1);
    expect(reads).toBe(1);
    expect([...registry.snapshot("test")!.keyboards.keys()]).toEqual(["test", "second"]);
    expect((yield* Effect.exit(registry.engines("missing")))._tag).toBe("Failure");
  }).pipe(Effect.provide(services)),
);

it.effect("an unreadable manifest fails the module when its engines are listed", () =>
  Effect.gen(function* () {
    const registry = yield* makeModuleRegistry({
      hostUrl: url,
      runtimeUrl: url,
      modules: { test: url },
      loadManifest: async () => ({ ...manifest, engines: [] }),
      start: async () => new FakeConnection(),
    });
    expect((yield* Effect.exit(registry.engines("test")))._tag).toBe("Failure");
    expect(registry.state("test")).toBe("failed");
  }).pipe(Effect.provide(services)),
);
```

- [ ] **Step 4: Write the failing facade tests**

In `packages/ibus-web/test/browser/facade.test.ts`, insert before `test("publishes state and storage CustomEvents from actual core lifecycle, including restart and unload", …)`:

```ts
test("lists a module's engines without starting a Worker and rejects an unknown module", async () => {
  const f = fixture();
  expect(await f.app.engines("test")).toEqual(manifest.engines);
  expect(f.start).not.toHaveBeenCalled();
  await expect(f.app.engines("missing")).rejects.toThrow("Unknown module: missing");
});
test("selection and selectionchange follow select, deselect and unload", async () => {
  const f = fixture();
  f.app.attach(f.native);
  f.native.focus();
  expect(f.app.selection).toBeUndefined();
  const selected = nextEvent(f.app, "selectionchange");
  await f.app.select("test");
  expect((await selected).detail).toEqual({ module: "test", engine: "test" });
  expect(f.app.selection).toEqual({ module: "test", engine: "test" });
  await expect(f.app.select("test", "missing")).rejects.toThrow(/Unknown engine/);
  expect(f.app.selection).toEqual({ module: "test", engine: "test" });
  const deselected = nextEvent(f.app, "selectionchange");
  await f.app.deselect();
  expect((await deselected).detail).toBeNull();
  expect(f.app.selection).toBeUndefined();
  expect(key(f.native).defaultPrevented).toBe(false);
  expect(f.connections[0]!.terminated).toBe(false);
  await f.app.select("test", "test");
  const unloaded = nextEvent(f.app, "selectionchange");
  await f.app.unload("test");
  expect((await unloaded).detail).toBeNull();
});
```

- [ ] **Step 5: Run the Node tests to see them fail**

```bash
nix develop -c pnpm -r run build
nix develop -c pnpm --dir packages/core test test/node/router/services.test.ts
```

Expected: FAIL in the two new tests with `registry.engines is not a function`.

- [ ] **Step 6: Read a module's manifest without starting it**

In `packages/core/src/services/modules.ts`, import the descriptor type:

```ts
// before
import {
  asError,
  ModuleManifest,
  Init,
```

```ts
// after
import {
  asError,
  ModuleManifest,
  Init,
  type EngineDescriptor,
```

declare the method:

```ts
// before
  select(name: string | undefined): Effect.Effect<void, Error>;
  ensure(name: string): Effect.Effect<void, Error>;
```

```ts
// after
  select(name: string | undefined): Effect.Effect<void, Error>;
  /** Reads and validates the module's manifest without starting its Worker. */
  engines(name: string): Effect.Effect<readonly EngineDescriptor[], Error>;
  ensure(name: string): Effect.Effect<void, Error>;
```

move the manifest read out of `boot` into a shared, cached read:

```ts
// before
    const boot = (name: string, entry: Entry) =>
      Effect.gen(function* () {
        const lifetime = entry.lifetime!;
        if (!entry.snapshot.manifest) {
          const raw = yield* Effect.tryPromise({
            try: () =>
              options.loadManifest
                ? options.loadManifest(options.modules[name]!)
                : fetch(options.modules[name]!).then((response) => {
                    if (!response.ok) throw new Error(`Manifest fetch failed: ${response.status}`);
                    return response.json();
                  }),
            catch: asError,
          });
          const manifest = yield* Effect.try({
            try: () => Schema.decodeUnknownSync(ModuleManifest, { onExcessProperty: "error" })(raw),
            catch: asError,
          });
          yield* Effect.try({
            try: () => {
              for (const engine of manifest.engines) validateKeyboard(engine.keyboard);
            },
            catch: asError,
          });
          if (manifest.protocol !== PROTOCOL_VERSION)
            return yield* Effect.fail(
              new InitializationRejected(`ProtocolMismatch: page ${PROTOCOL_VERSION}, manifest ${manifest.protocol}`),
            );
          const owner = distributions.get(manifest.name);
          if (owner !== undefined && owner !== name)
            return yield* Effect.fail(new Error(`Distribution ${manifest.name} is already registered as ${owner}`));
          distributions.set(manifest.name, name);
          entry.snapshot.manifest = manifest;
          entry.snapshot.keyboards = keyboards(manifest);
        }
        const manifest = entry.snapshot.manifest;
```

```ts
// after
    const readManifest = async (name: string): Promise<ModuleManifest> => {
      const url = options.modules[name]!;
      const raw = options.loadManifest
        ? await options.loadManifest(url)
        : await fetch(url).then((response) => {
            if (!response.ok) throw new Error(`Manifest fetch failed: ${response.status}`);
            return response.json();
          });
      const manifest = Schema.decodeUnknownSync(ModuleManifest, { onExcessProperty: "error" })(raw);
      for (const engine of manifest.engines) validateKeyboard(engine.keyboard);
      if (manifest.protocol !== PROTOCOL_VERSION)
        throw new InitializationRejected(`ProtocolMismatch: page ${PROTOCOL_VERSION}, manifest ${manifest.protocol}`);

      const owner = distributions.get(manifest.name);
      if (owner !== undefined && owner !== name)
        throw new Error(`Distribution ${manifest.name} is already registered as ${owner}`);
      distributions.set(manifest.name, name);
      return manifest;
    };
    // Listing engines and starting the Worker share one read; a failed read is retried on the next use.
    const reads = new Map<string, Promise<ModuleManifest>>();
    const manifestOf = (name: string, entry: Entry): Effect.Effect<ModuleManifest, Error> =>
      Effect.suspend(() => {
        if (entry.snapshot.manifest) return Effect.succeed(entry.snapshot.manifest);

        let read = reads.get(name);
        if (!read) {
          read = readManifest(name).then(
            (manifest) => {
              reads.delete(name);
              entry.snapshot.manifest = manifest;
              entry.snapshot.keyboards = keyboards(manifest);
              return manifest;
            },
            (cause: unknown) => {
              reads.delete(name);
              throw cause;
            },
          );
          reads.set(name, read);
        }
        const pending = read;
        return Effect.tryPromise({ try: () => pending, catch: asError });
      });
    const boot = (name: string, entry: Entry) =>
      Effect.gen(function* () {
        const lifetime = entry.lifetime!;
        const manifest = yield* manifestOf(name, entry);
```

and add `engines` to the service, after `ensure,`:

```ts
// before
      ensure,
      select: (name) =>
```

```ts
// after
      ensure,
      engines: (name) =>
        Effect.suspend(() => {
          const entry = entries.get(name);
          if (!entry) return Effect.fail(new Error(`Unknown module: ${name}`));
          return manifestOf(name, entry).pipe(
            Effect.map((manifest) => manifest.engines),
            // An unreadable manifest fails the module, as it would when the module started.
            Effect.tapError(() =>
              Effect.sync(() => {
                if (!entry.started) fail(entry);
              }),
            ),
          );
        }),
      select: (name) =>
```

- [ ] **Step 7: Rewrite the router around `{ module, engine }`**

Replace `packages/core/src/router/router.ts` with:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Context, Effect, Layer, PubSub, Stream } from "effect";
import {
  asError,
  CreateEngine,
  DestroyEngine,
  Disable,
  Enable,
  FocusIn,
  FocusOut,
  Reset,
  SetCapabilities,
  SetContentType,
  IBusCapability as Cap,
  type EngineDescriptor,
  type PanelEvent,
  type Request,
} from "@ibus-web/protocol";
import { ModuleRegistry } from "../services/modules.ts";
import { CoreConfig } from "../services/config.ts";
import { PanelEvents, SyncMailbox } from "../services/logging.ts";
import type { AsyncKeyResult, SurfaceAdapter } from "./replay.ts";
import { InputContext } from "./contexts.ts";

export interface HotkeyRegistry {
  add(predicate: (event: KeyboardEvent) => boolean, action: () => void): () => void;
}

export interface AttachOptions {
  /** sync preserves native passthrough; async owns fallback; manual leaves keyboard capture to the editor. */
  readonly keyMode?: "sync" | "async" | "manual";
}

export interface Selection {
  readonly module: string;
  readonly engine: string;
}

export interface RouterService {
  attach(adapter: SurfaceAdapter, options?: AttachOptions): () => void;
  /**
   * Call during the original event dispatch. Accepted keys are prevented immediately;
   * excluded keys retain native handling. The router applies fallback before returning
   * `replayed`; callers must not prevent excluded events or replay the result again.
   * Detach/disposal cancels pending ownership. Adapter callback failures reject.
   */
  keyAsync(adapter: SurfaceAdapter, event: KeyboardEvent): Promise<AsyncKeyResult>;
  /** Without an engine, selects the module's first. An unknown module or engine fails before anything changes. */
  select(module: string, engine?: string): Effect.Effect<void, Error>;
  /** Returns every surface, overrides included, to plain browser input; Workers stay loaded. */
  deselect(): Effect.Effect<void, Error>;
  unload(module: string): Effect.Effect<void, Error>;
  activeContext(): { module: string; engine: string; ic: number; adapter: SurfaceAdapter } | undefined;
  /** Without an engine, the module's first; `undefined` returns the surface to the page's selection. */
  override(
    adapter: SurfaceAdapter,
    selection: { readonly module: string; readonly engine?: string } | undefined,
  ): Effect.Effect<void, Error>;
  readonly selection: Selection | undefined;
  readonly selectionChanges: Stream.Stream<Selection | undefined>;
  readonly hotkeys: HotkeyRegistry;
  readonly panel: Stream.Stream<PanelEvent>;
}

export class Router extends Context.Service<Router, RouterService>()("@ibus-web/core/Router") {
  static readonly Default = Layer.effect(
    Router,
    Effect.suspend(() => makeRouter),
  );
}

interface Surface {
  readonly adapter: SurfaceAdapter;
  readonly ic: number;
  /** By module: the host holds one engine per input context, so a module's engines take turns in one. */
  readonly contexts: Map<string, InputContext>;
  attached: boolean;
  focused: boolean;
  suspended: boolean;
  /** Overrides waiting on a manifest read; until they apply, the surface wants no context. */
  reading: number;
  /** Counts override changes, so one that had to wait for a manifest applies only if none came after it. */
  overrides: number;
  override: Selection | undefined;
  active: InputContext | undefined;
  cleanup: () => void;
}

interface PendingReset {
  readonly context: InputContext;
  readonly generation: number;
  reserve(): void;
  release(): void;
}

const same = (a: Selection | undefined, b: Selection | undefined) => a?.module === b?.module && a?.engine === b?.engine;

export const makeRouter = Effect.gen(function* () {
  const registry = yield* ModuleRegistry;
  const config = yield* CoreConfig;
  const panel = yield* PanelEvents;
  const surfaces = new Map<SurfaceAdapter, Surface>();
  // Unload bypasses the mailbox, so queued selections must retain their original lifetime.
  const selectionEpochs = new Map<string, number>();
  const hotkeys = new Set<{ predicate: (event: KeyboardEvent) => boolean; action: () => void }>();
  const mailbox = new SyncMailbox<() => Effect.Effect<void, Error>>();
  // A selection whose module's manifest hasn't been read yet waits for the read in the mailbox. Until then,
  // surfaces following the page want no context, so output for a context it replaces is dropped at once.
  // `selections` counts selection changes, so a waiting one applies only if none came after it.
  let selected: Selection | undefined,
    reading = 0,
    selections = 0,
    nextIc = 1,
    closed = false;

  const changes = new SyncMailbox<Selection | undefined>();
  const pubsub = yield* PubSub.unbounded<Selection | undefined>();
  yield* Effect.addFinalizer(() => Effect.sync(() => changes.close()));
  yield* Effect.addFinalizer(() => PubSub.shutdown(pubsub));
  yield* changes.take.pipe(
    Effect.flatMap((selection) => PubSub.publish(pubsub, selection)),
    Effect.forever,
    Effect.forkScoped,
  );
  const choose = (selection: Selection | undefined) => {
    if (same(selected, selection)) return;
    selected = selection;
    changes.enqueue(selection);
  };
  const apply = (selection: Selection | undefined) => {
    if (!same(selected, selection))
      for (const surface of surfaces.values()) if (surface.override === undefined) surface.suspended = true;
    choose(selection);
  };
  const setOverride = (surface: Surface, selection: Selection | undefined) => {
    if (same(surface.override, selection)) return;
    surface.override = selection;
    surface.suspended = true;
  };

  const desired = (surface: Surface) =>
    surface.reading > 0 ? undefined : (surface.override ?? (reading > 0 ? undefined : selected));
  const wants = (surface: Surface, target: Selection) =>
    !closed &&
    surface.attached &&
    surface.focused &&
    !surface.adapter.contentType().disabled &&
    same(desired(surface), target);
  const pick = (engines: readonly EngineDescriptor[], module: string, engine: string | undefined) => {
    const name = engine ?? engines[0]!.name;
    return engines.some((descriptor) => descriptor.name === name)
      ? ({ module, engine: name } satisfies Selection)
      : new Error(`Unknown engine: ${name} in module ${module}`);
  };
  const resolve = (module: string, engine: string | undefined) =>
    registry.engines(module).pipe(
      Effect.flatMap((engines) => {
        const target = pick(engines, module, engine);
        return target instanceof Error ? Effect.fail(target) : Effect.succeed(target);
      }),
    );

  const live = (context: InputContext) =>
    registry.snapshot(context.module)?.generation === context.generation &&
    !!registry.snapshot(context.module)?.connection;
  const request = (context: InputContext, message: Request) =>
    Effect.tryPromise({ try: () => registry.request(context.module, message, context.ic), catch: asError });
  const refresh = (surface: Surface, context: InputContext) =>
    Effect.gen(function* () {
      if (!wants(surface, context) || !context.created || !context.focused || !live(context)) return;
      for (const message of context.updates(config.surroundingWindow)) {
        if (!wants(surface, context) || !live(context)) return;
        yield* request(context, message);
      }
    });
  const drain = (context: InputContext) =>
    Effect.tryPromise({ try: () => registry.drainContext(context.module, context), catch: asError });
  const pendingSubmissions = new Set<() => void>();
  const pendingRefresh = new Set<InputContext>();
  const pendingResets = new Set<PendingReset>();
  const enqueueRefresh = (surface: Surface, context: InputContext) => {
    if (pendingRefresh.has(context) || closed) return;
    pendingRefresh.add(context);
    mailbox.enqueue(() =>
      Effect.gen(function* () {
        pendingRefresh.delete(context);
        yield* refresh(surface, context);
      }),
    );
  };
  const finish = (surface: Surface) => {
    if (surface.active) {
      surface.active.ready = false;
      surface.active.finish();
    }
  };

  // Another engine of the module takes over the surface's input context, so the old one is destroyed first.
  const replace = (surface: Surface, context: InputContext) =>
    Effect.gen(function* () {
      surface.contexts.delete(context.module);
      context.unregister();
      if (context.created && live(context)) yield* request(context, new DestroyEngine({}));
      context.invalidate();
    });

  const reconcile = (surface: Surface) =>
    Effect.gen(function* () {
      const target = desired(surface),
        old = surface.active;

      if (old && !wants(surface, old)) {
        const switching = !same(target, old);
        surface.suspended = true;
        yield* drain(old);
        old.finish();
        old.ready = false;
        old.acceptOutput = false;
        if (live(old) && old.created) {
          if (switching && old.enabled) {
            old.enabled = false;
            yield* request(old, new Disable({}));
          }
          if (old.focused) {
            old.focused = false;
            yield* request(old, new FocusOut({}));
          }
        }
        panel.enqueue({ _tag: "hide", module: old.module, ic: old.ic });
        if (switching) surface.active = undefined;
      }

      if (target === undefined || !wants(surface, target)) return;
      yield* registry.ensure(target.module);
      if (!wants(surface, target)) return;

      const existing = surface.contexts.get(target.module);
      if (existing && existing.engine !== target.engine) {
        yield* replace(surface, existing);
        if (!wants(surface, target)) return;
      }

      const snapshot = registry.snapshot(target.module)!;
      let context = surface.contexts.get(target.module);
      if (!context) {
        const created = new InputContext({
          ic: surface.ic,
          module: target.module,
          engine: target.engine,
          generation: snapshot.generation,
          adapter: surface.adapter,
          current: () =>
            surface.attached &&
            live(created) &&
            (created.created ? created.acceptOutput : wants(surface, created) && surface.active === created),
          refresh: () => enqueueRefresh(surface, created),
          panel: (event) => panel.enqueue(event),
        });
        context = created;
        surface.contexts.set(target.module, context);
        context.unregister = registry.registerContext(target.module, context);
      }
      surface.active = context;
      if (context.generation !== snapshot.generation) {
        context.invalidate();
        context.generation = snapshot.generation;
      }
      const generation = context.generation;
      const current = () => wants(surface, target) && live(context) && generation === context.generation;

      if (!context.created) {
        const reply = yield* request(context, new CreateEngine({ name: context.engine }));
        if (generation !== registry.snapshot(target.module)?.generation) return;
        if (reply.ret < 0) return;
        context.created = true;
      }
      if (!current()) return;
      context.acceptOutput = true;

      if (!context.focused) {
        const capabilities = surface.adapter.capabilities();
        yield* request(
          context,
          new SetCapabilities({
            capabilities:
              Cap.FOCUS |
              Cap.PROPERTY |
              (capabilities.preedit ? Cap.PREEDIT_TEXT : 0) |
              (capabilities.auxText ? Cap.AUXILIARY_TEXT : 0) |
              (capabilities.lookupTable ? Cap.LOOKUP_TABLE : 0) |
              (capabilities.surroundingText && surface.adapter.surrounding(config.surroundingWindow) !== undefined
                ? Cap.SURROUNDING_TEXT
                : 0),
          }),
        );
        if (!current()) return;
        const { purpose, hints } = surface.adapter.contentType();
        yield* request(context, new SetContentType({ purpose, hints }));
        if (!current()) return;
        if (!context.enabled) {
          yield* request(context, new Enable({}));
          context.enabled = true;
        }
        if (!current()) return;
        yield* request(context, new FocusIn({}));
        context.focused = true;
        if (!current()) return;
      }

      // Earlier blur owners have drained. Reserve deferred resets before this
      // context accepts keys that could otherwise overtake them during refresh.
      for (const pending of pendingResets)
        if (pending.context === context && pending.generation === generation) pending.reserve();
      context.ready = true;
      surface.suspended = false;
      yield* refresh(surface, context);
    });

  const submit = (work: () => Effect.Effect<void, Error>): Effect.Effect<void, Error> =>
    Effect.callback((resume) => {
      const cancel = () => resume(Effect.fail(new Error("Router is closed")));
      if (closed) {
        cancel();
        return;
      }
      pendingSubmissions.add(cancel);
      mailbox.enqueue(() =>
        work().pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.sync(() => {
                pendingSubmissions.delete(cancel);
                resume(Effect.fail(error));
              }),
            onSuccess: () =>
              Effect.sync(() => {
                pendingSubmissions.delete(cancel);
                resume(Effect.void);
              }),
          }),
        ),
      );
      return Effect.sync(() => {
        pendingSubmissions.delete(cancel);
      });
    });
  yield* mailbox.take.pipe(
    Effect.flatMap((work) => Effect.suspend(work).pipe(Effect.catch((error) => Effect.logWarning(error)))),
    Effect.forever,
    Effect.forkScoped,
  );

  // Holds a read-waiting change's count until it applies or fails; the returned release is idempotent.
  const hold = (count: { increment(): void; decrement(): void }) => {
    let held = true;
    count.increment();
    return () => {
      if (!held) return;
      held = false;
      count.decrement();
    };
  };
  // A change that fails leaves the selection as it was, and the surfaces it suspended return to it.
  const restore = (release: () => void, error: Error) =>
    Effect.gen(function* () {
      release();
      for (const surface of surfaces.values()) yield* Effect.ignore(reconcile(surface));
      return yield* Effect.fail(error);
    });

  const attempt = (errors: unknown[], work: () => void) => {
    try {
      work();
    } catch (error) {
      errors.push(error);
    }
  };
  const detachSurface = (surface: Surface): unknown[] => {
    if (!surface.attached) return [];
    const errors: unknown[] = [];
    surface.attached = false;
    surface.focused = false;
    attempt(errors, surface.cleanup);
    attempt(errors, () => finish(surface));
    surfaces.delete(surface.adapter);
    for (const context of surface.contexts.values()) attempt(errors, context.unregister);
    mailbox.enqueue(() =>
      Effect.gen(function* () {
        for (const context of surface.contexts.values())
          if (context.created && live(context)) {
            if (context.focused) {
              context.focused = false;
              yield* request(context, new FocusOut({}));
            }
            yield* request(context, new DestroyEngine({}));
            context.invalidate();
            panel.enqueue({ _tag: "hide", module: context.module, ic: context.ic });
          }
      }),
    );
    return errors;
  };
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
      mailbox.close();
      pendingRefresh.clear();
      hotkeys.clear();
      for (const cancel of pendingSubmissions) cancel();
      pendingSubmissions.clear();
      const errors: unknown[] = [];
      for (const surface of surfaces.values()) errors.push(...detachSurface(surface));
      surfaces.clear();
      for (const pending of pendingResets) attempt(errors, pending.release);
      pendingResets.clear();
      if (errors.length) throw new AggregateError(errors, "Surface teardown failed");
    }),
  );

  const service: RouterService = {
    panel: panel.events,
    get selection() {
      return selected;
    },
    selectionChanges: Stream.fromPubSub(pubsub),
    activeContext: () => {
      for (const surface of surfaces.values()) {
        const context = surface.active;
        if (context && surface.focused && surface.attached && context.ready && wants(surface, context))
          return { module: context.module, engine: context.engine, ic: context.ic, adapter: surface.adapter };
      }
      return undefined;
    },
    unload: (module) =>
      Effect.suspend(() => {
        if (closed) return Effect.fail(new Error("Router is closed"));
        if (!registry.snapshot(module)) return Effect.fail(new Error(`Unknown module: ${module}`));
        selectionEpochs.set(module, (selectionEpochs.get(module) ?? 0) + 1);
        const errors: unknown[] = [];
        if (selected?.module === module) choose(undefined);
        for (const surface of surfaces.values()) {
          if (surface.override?.module === module) surface.override = undefined;
          const context = surface.contexts.get(module);
          if (!context) continue;
          context.unregister();
          context.invalidate();
          surface.contexts.delete(module);
          if (surface.active === context) {
            surface.active = undefined;
            attempt(errors, () => surface.adapter.setPreedit(undefined));
          }
          panel.enqueue({ _tag: "hide", module, ic: context.ic });
        }
        return registry
          .unload(module)
          .pipe(
            Effect.andThen(() =>
              errors.length ? Effect.fail(new AggregateError(errors, "Module surface teardown failed")) : Effect.void,
            ),
          );
      }),
    hotkeys: {
      add: (predicate, action) => {
        const entry = { predicate, action };
        if (!closed) hotkeys.add(entry);
        return () => {
          hotkeys.delete(entry);
        };
      },
    },
    select: (module, engine) =>
      Effect.suspend(() => {
        if (closed) return Effect.fail(new Error("Router is closed"));
        const snapshot = registry.snapshot(module);
        if (!snapshot) return Effect.fail(new Error(`Unknown module: ${module}`));

        const epoch = selectionEpochs.get(module) ?? 0;
        const cancelled = () => epoch !== (selectionEpochs.get(module) ?? 0);
        const cancellation = () => Effect.fail(new Error(`Selection of ${module} was cancelled by unload`));
        const start = Effect.gen(function* () {
          yield* registry.ensure(module);
          if (cancelled()) return yield* cancellation();
          for (const surface of surfaces.values()) yield* reconcile(surface);
        });

        if (snapshot.manifest) {
          const target = pick(snapshot.manifest.engines, module, engine);
          if (target instanceof Error) return Effect.fail(target);
          selections++;
          apply(target);
          return submit(() =>
            Effect.gen(function* () {
              if (cancelled()) return yield* cancellation();
              yield* start;
            }),
          );
        }

        const call = ++selections;
        const release = hold({ increment: () => reading++, decrement: () => reading-- });
        for (const surface of surfaces.values()) if (surface.override === undefined) surface.suspended = true;
        return submit(() =>
          Effect.gen(function* () {
            if (cancelled()) return yield* cancellation();
            const target = yield* resolve(module, engine);
            if (cancelled()) return yield* cancellation();
            if (call === selections) apply(target);
            release();
            yield* start;
          }).pipe(
            Effect.catch((error) => restore(release, error)),
            Effect.ensuring(Effect.sync(release)),
          ),
        );
      }),
    deselect: () =>
      Effect.suspend(() => {
        if (closed) return Effect.fail(new Error("Router is closed"));
        selections++;
        apply(undefined);
        for (const surface of surfaces.values()) {
          surface.overrides++;
          setOverride(surface, undefined);
        }
        return submit(() =>
          Effect.gen(function* () {
            for (const surface of surfaces.values()) yield* reconcile(surface);
          }),
        );
      }),
    override: (adapter, selection) =>
      Effect.suspend(() => {
        const surface = surfaces.get(adapter);
        if (!surface) return Effect.fail(new Error("Surface is not attached"));
        if (selection === undefined) {
          surface.overrides++;
          setOverride(surface, undefined);
          return submit(() => reconcile(surface));
        }

        const snapshot = registry.snapshot(selection.module);
        if (!snapshot) return Effect.fail(new Error(`Unknown module: ${selection.module}`));
        if (snapshot.manifest) {
          const target = pick(snapshot.manifest.engines, selection.module, selection.engine);
          if (target instanceof Error) return Effect.fail(target);
          surface.overrides++;
          setOverride(surface, target);
          return submit(() => reconcile(surface));
        }

        const call = ++surface.overrides;
        const release = hold({ increment: () => surface.reading++, decrement: () => surface.reading-- });
        surface.suspended = true;
        return submit(() =>
          Effect.gen(function* () {
            const target = yield* resolve(selection.module, selection.engine);
            if (call === surface.overrides) setOverride(surface, target);
            release();
            yield* reconcile(surface);
          }).pipe(
            Effect.catch((error) => restore(release, error)),
            Effect.ensuring(Effect.sync(release)),
          ),
        );
      }),
    keyAsync: (adapter, event) => {
      const surface = surfaces.get(adapter),
        context = surface?.active;
      if (!surface || !context || surface.suspended || !wants(surface, context)) return Promise.resolve("passthrough");
      return registry.keyAsync(context.module, context, event);
    },
    attach: (adapter, { keyMode = "sync" } = {}) => {
      if (closed) throw new Error("Router is closed");
      if (surfaces.has(adapter)) throw new Error("Surface is already attached");
      const surface: Surface = {
        adapter,
        ic: nextIc++,
        contexts: new Map(),
        attached: true,
        focused: adapter.element.ownerDocument.activeElement === adapter.element,
        suspended: false,
        reading: 0,
        overrides: 0,
        override: undefined,
        active: undefined,
        cleanup: () => {},
      };
      surfaces.set(adapter, surface);
      const focus = () => {
        surface.focused = true;
        mailbox.enqueue(() => reconcile(surface));
      };
      const blur = () => {
        const context = surface.active;
        const waitForBoundary = context && registry.captureDrainContext(context.module, context);
        surface.focused = false;
        surface.suspended = true;
        mailbox.enqueue(() =>
          Effect.gen(function* () {
            // Later focus intervals can accept keys before this mailbox item runs.
            // This blur waits only for owners captured at its actual event boundary.
            if (context && waitForBoundary) {
              yield* Effect.tryPromise({ try: waitForBoundary, catch: asError });
              context.finish();
              context.ready = false;
              context.acceptOutput = false;
            }
            if (context?.created && context.focused && live(context)) {
              context.focused = false;
              yield* request(context, new FocusOut({}));
              panel.enqueue({ _tag: "hide", module: context.module, ic: context.ic });
            }
            yield* reconcile(surface);
          }),
        );
      };
      const reset = () => {
        const context = surface.active;
        if (!context || !context.created || !live(context)) return;
        const generation = context.generation;
        let resume: (() => void) | undefined;
        let released = false;
        const pending: PendingReset = {
          context,
          generation,
          reserve: () => {
            if (!released && context.generation === generation && live(context))
              resume ??= registry.holdKeys(context.module);
          },
          release: () => {
            released = true;
            pendingResets.delete(pending);
            resume?.();
          },
        };
        pendingResets.add(pending);
        try {
          // Inactive contexts defer their reservation until reconciliation makes
          // them eligible, leaving older blur owners free to drain first.
          if (context.ready && !surface.suspended && wants(surface, context)) pending.reserve();
          registry.retireContext(context.module, context, () => context.preedit.finish(context.adapter));
          enqueueRefresh(surface, context);
          mailbox.enqueue(() =>
            Effect.gen(function* () {
              if (!wants(surface, context) || !live(context) || context.generation !== generation) return;
              yield* request(context, new Reset({}));
              yield* refresh(surface, context);
            }).pipe(Effect.ensuring(Effect.sync(pending.release))),
          );
        } catch (error) {
          pending.release();
          throw error;
        }
      };
      // Install adapter reset detection before the sink sees the same DOM event.
      const removeReset = adapter.onReset(reset);
      const key = (event: KeyboardEvent) => {
        if (adapter.contentType().disabled || event.isComposing || event.key === "Dead") return;
        if (event.type === "keydown")
          for (const binding of hotkeys)
            if (binding.predicate(event)) {
              binding.action();
              event.preventDefault();
              event.stopPropagation();
              return;
            }
        if (keyMode === "async") {
          void service.keyAsync(adapter, event).catch((cause) => {
            mailbox.enqueue(() => Effect.fail(asError(cause)));
          });
          return;
        }
        const context = surface.active;
        if (!context || surface.suspended || !wants(surface, context)) return;
        if (registry.keySink(context.module, context).key(event) === "consumed") {
          event.preventDefault();
          event.stopPropagation();
        }
      };
      adapter.element.addEventListener("focus", focus);
      adapter.element.addEventListener("blur", blur);
      if (keyMode !== "manual") {
        adapter.element.addEventListener("keydown", key, true);
        adapter.element.addEventListener("keyup", key, true);
      }
      surface.cleanup = () => {
        try {
          removeReset();
        } finally {
          adapter.element.removeEventListener("focus", focus);
          adapter.element.removeEventListener("blur", blur);
          adapter.element.removeEventListener("keydown", key, true);
          adapter.element.removeEventListener("keyup", key, true);
        }
      };
      if (surface.focused) mailbox.enqueue(() => reconcile(surface));
      return () => {
        const errors = detachSurface(surface);
        if (errors.length) throw new AggregateError(errors, "Surface teardown failed");
      };
    },
  };
  return service;
});
```

Export the selection type from `packages/core/src/page/index.ts`:

```ts
// before
export { Router, makeRouter, type AttachOptions, type HotkeyRegistry, type RouterService } from "../router/router.ts";
```

```ts
// after
export {
  Router,
  makeRouter,
  type AttachOptions,
  type HotkeyRegistry,
  type RouterService,
  type Selection,
} from "../router/router.ts";
```

- [ ] **Step 8: Run the Node tests to see them pass**

```bash
nix develop -c pnpm -r run build
nix develop -c pnpm --dir packages/core test
```

Expected: PASS (177 tests).

- [ ] **Step 9: Add engines, deselect and the selection to the facade**

`packages/ibus-web/src/index.ts`:

```ts
// before
  type RouterService,
  type SettingsApiService,
```

```ts
// after
  type RouterService,
  type Selection,
  type SettingsApiService,
```

```ts
// before
import { errorMessage, PanelAction } from "@ibus-web/protocol";
```

```ts
// after
import { errorMessage, PanelAction, type EngineDescriptor } from "@ibus-web/protocol";
```

```ts
// before
export type { AttachOptions, AsyncKeyResult, SurfaceAdapter, SettingsSourceService } from "@ibus-web/core";
```

```ts
// after
export type { AttachOptions, AsyncKeyResult, Selection, SurfaceAdapter, SettingsSourceService } from "@ibus-web/core";
export type { EngineDescriptor } from "@ibus-web/protocol";
```

```ts
// before
  storage: CustomEvent<Omit<Extract<ModuleEvent, { _tag: "storage" }>, "_tag">>;
```

```ts
// after
  storage: CustomEvent<Omit<Extract<ModuleEvent, { _tag: "storage" }>, "_tag">>;
  /** `null` after deselection: a CustomEvent can't carry an undefined detail. */
  selectionchange: CustomEvent<Selection | null>;
```

```ts
// before
  select(module: string): Promise<void>;
  unload(module: string): Promise<void>;
  /** Development only: terminates the actual Worker and awaits normal recovery. */
  debugRestart(module: string): Promise<void>;
```

```ts
// after
  /** Without an engine, selects the module's first. An unknown module or engine rejects before anything changes. */
  select(module: string, engine?: string): Promise<void>;
  /** Returns every surface to plain browser input; Workers stay loaded. */
  deselect(): Promise<void>;
  unload(module: string): Promise<void>;
  /** Development only: terminates the actual Worker and awaits normal recovery. */
  debugRestart(module: string): Promise<void>;
  /** Reads and validates the module's manifest without starting its Worker. */
  engines(module: string): Promise<EngineDescriptor[]>;
  readonly selection: Selection | undefined;
```

```ts
// before
/** No services, storage or Workers are acquired until selection or a settings operation. */
```

```ts
// after
/** No services or storage are acquired until selection, an engine listing or a settings operation; only selection starts Workers. */
```

```ts
// before
      yield* router.panel.pipe(
        Stream.runForEach((event) => Effect.sync(() => emit("panel", event))),
        Effect.forkScoped,
      );
```

```ts
// after
      yield* router.panel.pipe(
        Stream.runForEach((event) => Effect.sync(() => emit("panel", event))),
        Effect.forkScoped,
      );
      yield* router.selectionChanges.pipe(
        Stream.runForEach((selection) => Effect.sync(() => emit("selectionchange", selection ?? null))),
        Effect.forkScoped,
      );
```

```ts
// before
    select: async (module: string) => {
      const current = await initialize();
      await runtime.runPromise(current.router.select(module));
      await refreshOrientation(module, current.settings);
    },
```

```ts
// after
    select: async (module: string, engine?: string) => {
      const current = await initialize();
      await runtime.runPromise(current.router.select(module, engine));
      await refreshOrientation(module, current.settings);
    },
    deselect: async () => {
      alive();
      if (!initializing) return;
      const current = await initialize();
      await runtime.runPromise(current.router.deselect());
    },
```

```ts
// before
    debugRestart: async (module: string) => {
      const current = await initialize();
      await runtime.runPromise(current.registry.debugRestart(module));
      await runtime.runPromise(current.router.select(module));
    },
```

```ts
// after
    debugRestart: async (module: string) => {
      const current = await initialize();
      const selection = current.router.selection;
      await runtime.runPromise(current.registry.debugRestart(module));
      await runtime.runPromise(
        current.router.select(module, selection?.module === module ? selection.engine : undefined),
      );
    },
    engines: async (module: string) => {
      alive();
      if (!Object.hasOwn(options.modules, module)) throw new Error(`Unknown module: ${module}`);
      const current = await initialize();
      return [...(await runtime.runPromise(current.registry.engines(module)))];
    },
    selection: undefined as Selection | undefined,
```

```ts
// before
      return disposal;
    },
  });
  return app;
```

```ts
// after
      return disposal;
    },
  });
  // Object.assign copies a getter's value once, so the live getter is defined afterwards.
  Object.defineProperty(app, "selection", {
    enumerable: true,
    get: () => (closed ? undefined : services?.router.selection),
  });
  return app;
```

- [ ] **Step 10: Update the docs**

`docs/core.md`:

```markdown
<!-- before -->
`router.select(module)` selects the page's module; `router.override(adapter, module)`
sets a surface override, and `undefined` restores the page choice. Both return
Effects. Attachment assigns a context ID and returns an idempotent detach function.
Instances are created lazily on focus. `router.hotkeys.add(predicate, action)`
returns a removal function; there are no default router hotkeys.
```

```markdown
<!-- after -->
A module is one distribution: one manifest, one Worker. Its engines are the input
methods inside it. `router.select(module, engine?)` selects an engine, the module's
first when `engine` is left out, and `router.deselect()` returns every surface,
overrides included, to native input while Workers stay loaded.
`router.override(adapter, { module, engine? })` sets a surface override, and
`undefined` restores the page choice. All three return Effects, and an unknown
module or engine fails them before anything changes. Naming an engine needs the
module's manifest: a selection of a module whose manifest hasn't been read waits in
the router's queue while `registry.engines(module)` reads it, which starts no
Worker, and until then surfaces following the page take native input. A later
selection supersedes a waiting one. `router.selection` is the page's
`{ module, engine }` and `router.selectionChanges` streams each change.

A surface keeps one input context per module, since the host holds one engine per
context. Switching engine within a module drains the context and sends `Disable`
and `FocusOut` as any switch does, then `DestroyEngine`, and creates the new engine
in the same context and Worker with `CreateEngine{engine}`. Attachment assigns a
context ID and returns an idempotent detach function. Instances are created lazily
on focus. `router.hotkeys.add(predicate, action)` returns a removal function; there
are no default router hotkeys.
```

`docs/ibus-web.md`:

```markdown
<!-- before -->
`createIbusWeb` acquires no Worker or storage until selection or a settings
operation.
```

```markdown
<!-- after -->
`createIbusWeb` acquires no services or storage until selection, an engine
listing or a settings operation, and only selection starts a Worker.
```

```markdown
<!-- before -->
`select(module)`, `unload(module)` and `dispose()` return Promises.
`debugRestart(module)` is a development-only way to terminate the actual Worker
and await recovery. No concrete CodeMirror adapter is provided.
```

```markdown
<!-- after -->
`select(module, engine?)` selects an engine of a module, the module's first when
`engine` is left out; switching engine within a module reuses its Worker. An
unknown module or engine rejects before anything changes. `deselect()` returns
every surface to plain browser input and keeps Workers loaded; hosts bind their own
shortcut for it, as there are no built-in hotkeys. `selection` is the current
`{ module, engine }` or `undefined`. `engines(module)` reads and validates a
module's manifest and resolves to its engine descriptors (`name`, `displayName`,
`languages`, `keyboard`) without starting a Worker. `select`, `deselect`,
`engines`, `unload(module)` and `dispose()` return Promises.
`debugRestart(module)` is a development-only way to terminate the actual Worker
and await recovery. No concrete CodeMirror adapter is provided.
```

```markdown
<!-- before -->
the optional `settings` service can replace it. `modulestate`, `storage`,
`panel` and `log` are typed CustomEvent names.
```

```markdown
<!-- after -->
the optional `settings` service can replace it. `modulestate`, `selectionchange`,
`storage`, `panel` and `log` are typed CustomEvent names; `selectionchange` carries
the new selection, or `null` after deselection.
```

`docs/specs/2026-09-26-ibus-web-design.md`, §7.1.3:

```markdown
<!-- before -->
#### 7.1.3 Engine selection

- One active engine for the page, with composition state per input context,
  matching IBus's shared-input-method default. A per-context override API
  exists.
- Switching sends `Disable` and `FocusOut` to the old instance, then creates
  or reuses the new one and sends `Enable` and `FocusIn`.
- A hotkey registry exists with no default bindings.
- A Worker starts when its engine is first selected and stays loaded until
  the host calls `unload(module)` or disposes the library.
```

```markdown
<!-- after -->
#### 7.1.3 Engine selection

- A module is one engine distribution: one manifest, one side module, one
  Worker. An engine is one input method inside it, created with
  `CreateEngine{name}`.
- One active engine for the page, with composition state per input context,
  matching IBus's shared-input-method default. A per-context override API
  exists and can name an engine.
- Switching sends `Disable` and `FocusOut` to the old instance, then creates
  or reuses the new one and sends `Enable` and `FocusIn`. Switching engine
  within a module reuses its Worker: the old engine is destroyed and the new
  one created in the same input context.
- `deselect()` returns every surface to plain browser input; Workers stay
  loaded.
- A hotkey registry exists with no default bindings.
- A Worker starts when its module is first selected and stays loaded until
  the host calls `unload(module)` or disposes the library.
```

and §7.4.1's facade list:

```markdown
<!-- before -->
- `select(module)`, `unload(module)` and `dispose()`.
- `debugRestart(module)`, for development: it terminates the engine's
  Worker and waits for the ordinary crash recovery.
- `settings.schemas`, `get`, `set` and `reset` (§7.1.4).
- Events `modulestate`, `storage`, `panel` and `log`.
```

```markdown
<!-- after -->
- `select(module, engine?)`, `deselect()`, `unload(module)` and `dispose()`;
  `selection` is the current `{ module, engine }`.
- `engines(module)` reads and validates a module's manifest without starting
  its Worker.
- `debugRestart(module)`, for development: it terminates the module's
  Worker and waits for the ordinary crash recovery.
- `settings.schemas`, `get`, `set` and `reset` (§7.1.4).
- Events `modulestate`, `selectionchange`, `storage`, `panel` and `log`.
```

- [ ] **Step 11: Format, type-check and run the checks**

```bash
nix develop -c oxfmt $(git diff --name-only -- '*.ts' '*.md' | grep -v '^docs/plans/')
nix develop -c pnpm -r run build
nix develop -c hk check --all -S tsc -S oxlint
nix build -L .#checks.x86_64-linux.core-node .#checks.x86_64-linux.core-browser \
  .#checks.x86_64-linux.ibus-web-browser .#checks.x86_64-linux.panel-browser \
  .#checks.x86_64-linux.example-hangul-smoke
```

Expected: `✔ tsc`, `✔ oxlint`, every check builds. In `core-browser`'s results, the seven new switching tests pass in Chromium and Firefox, and so does every existing router test, including `switch during pending Create drops its output and never focuses the stale selection` (it selects a module whose manifest hasn't been read, so it exercises Decision 5).

- [ ] **Step 12: Commit**

```bash
nix develop -c git add packages/core packages/ibus-web docs/core.md docs/ibus-web.md docs/specs/2026-09-26-ibus-web-design.md
nix develop -c git commit -m "feat(core): switch engines within a module and deselect" -- \
  packages/core packages/ibus-web docs/core.md docs/ibus-web.md docs/specs/2026-09-26-ibus-web-design.md
```

---

### Task 4: One demo for every module

`examples/hangul` becomes `examples/demo` (`@ibus-web/example-demo`). Modules join it through `ibusWeb.demo.modules`; the build links each distribution under `/ibus-web/modules/<name>/` beside a `modules.json` map that the page reads. The page lists every engine of every module in a picker, opens on the first module's default engine, and binds Ctrl+Space to toggle between `deselect()` and the last selection. The settings form follows the selected module. Hangul's Playwright tests move unchanged into `hangul.spec.ts`.

**Files:**

- Move: `examples/hangul/` → `examples/demo/`; `examples/demo/test/e2e/demo.spec.ts` → `hangul.spec.ts`; `examples/demo/test/e2e/settings.spec.ts` merges into `hangul.spec.ts`
- Create: `examples/demo/options.nix`, `examples/demo/test/e2e/hangul.ts`
- Modify: `examples/demo/{module.nix,package.json,vite.config.ts,index.html,src/main.ts,README.md}`, `examples/demo/test/e2e/{fixtures.ts,keystroke.bench.ts}`
- Modify: `engines/hangul/module.nix`, `pnpm-lock.yaml`
- Modify (docs): `README.md`, `docs/README.md`, `docs/core.md`, `docs/ibus-web.md`, `docs/testing.md`, `docs/tooling.md`, `docs/specs/2026-09-26-ibus-web-design.md`

**Interfaces:**

- Consumes: Task 3's facade (`engines`, `select(module, engine)`, `deselect`, `selection`, `selectionchange`, `modulestate` with `module`).
- Produces:
  - Option `ibusWeb.demo.modules: attrsOf package` (default `{ }`), declared in `examples/demo/options.nix`; Hangul sets `ibusWeb.demo.modules.hangul = config.packages.ibus-web-hangul-dist`. Plan C sets `ibusWeb.demo.modules.table`.
  - `packages.demo`, `packages.playwright-integration`, `apps.demo`, `apps.keystroke-bench`, `checks.example-demo-smoke`.
  - Page ids the tests use: `#engine-picker` (an `Off` option with value `""`, then one `<optgroup label="<module>">` per module of `<option>`s labelled with each engine's `displayName`), `#engine` (the selected module's state), `#storage`, `#mode`, `#settings`, `#settings-state` (`Settings ready; changes save automatically.` once the selected module's form is built), `#setting-<key>`, `#restart`, `#enabled`, `#input`, `#single-line`.
  - Playwright helpers: `test`, `expect`, `openDemo(page)` in `test/e2e/fixtures.ts`; Hangul's `hangul(page)` and `keyboardSetting(page, value)` in `test/e2e/hangul.ts`. A module's tests go in `test/e2e/<module>.spec.ts`.
  - Environment: `IBUS_WEB_DEMO_RUNTIME`, `IBUS_WEB_DEMO_HOST`, `IBUS_WEB_DEMO_MODULES` (a directory: `<module>/` per distribution and `modules.json`).

- [ ] **Step 1: Move the example**

```bash
nix develop -c git mv examples/hangul examples/demo
nix develop -c git mv examples/demo/test/e2e/demo.spec.ts examples/demo/test/e2e/hangul.spec.ts
ls examples/hangul 2>/dev/null
```

Expected: the `ls` prints nothing. If ignored build output (`node_modules`, `*.tsbuildinfo`) was left behind, delete that directory.

- [ ] **Step 2: Declare the demo's modules and add Hangul to them**

Create `examples/demo/options.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.demo.modules = lib.mkOption {
      type = lib.types.attrsOf lib.types.package;
      default = { };
      description = ''
        The module distributions the demo serves, by module name. The page lists every engine of
        each, and selects the first module's default engine when it opens.
      '';
    };
  };
}
```

In `engines/hangul/module.nix`, after the `packages.ibus-web-hangul-dist` binding:

```nix
# before
      checks.hangul-data-closure = pkgs.runCommand "ibus-web-hangul-data-closure" { } ''
```

```nix
# after
      ibusWeb.demo.modules.hangul = config.packages.ibus-web-hangul-dist;

      checks.hangul-data-closure = pkgs.runCommand "ibus-web-hangul-data-closure" { } ''
```

- [ ] **Step 3: Serve every module from the demo's Nix**

Replace `examples/demo/module.nix` with:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      inherit (config.ibusWeb) demo typescript;
      inherit (config.ibusWeb.testing) playwright;

      workspace = typescript.workspaceFor [ "examples/demo" ];

      # Each module's distribution under its name, beside the map from module name
      # to manifest that the page reads to find them.
      modules = pkgs.linkFarm "ibus-web-demo-modules" (
        lib.mapAttrsToList (name: path: { inherit name path; }) demo.modules
        ++ [
          {
            name = "modules.json";
            path = pkgs.writeText "ibus-web-demo-modules.json" (
              builtins.toJSON (lib.mapAttrs (name: _: "./${name}/manifest.json") demo.modules)
            );
          }
        ]
      );

      # What the page loads: the runtime, the Worker host and every module.
      env = {
        IBUS_WEB_DEMO_RUNTIME = "${config.packages.ibus-runtime}";
        IBUS_WEB_DEMO_HOST = "${workspace}/packages/worker-host/dist";
        IBUS_WEB_DEMO_MODULES = "${modules}";
      };

      exports =
        vars:
        lib.concatStringsSep "\n" (
          lib.mapAttrsToList (name: value: "export ${name}=${lib.escapeShellArg value}") vars
        );

      # A writable copy of the workspace, entered at the example.
      enterExample = ''
        cp -R ${workspace} source
        chmod -R u+w source
        cd source/examples/demo
      '';

      page =
        pkgs.runCommand "ibus-web-demo"
          (
            env
            // {
              nativeBuildInputs = [
                typescript.nodejs
                pkgs.pnpm
              ];
            }
          )
          ''
            ${enterExample}
            node node_modules/vite/bin/vite.js build --outDir "$out" --emptyOutDir
          '';

      # The browsers, offline, a font so text renders headless, and the built page.
      pageEnv = playwright.env // {
        IBUS_WEB_DEMO_PAGE = "${page}";
        FONTCONFIG_FILE = pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; };
      };

      playwrightTest = "node node_modules/playwright/cli.js test -c test/e2e/playwright.config.ts";

      integration =
        pkgs.runCommand "ibus-web-playwright-integration"
          (
            pageEnv
            // {
              nativeBuildInputs = [ typescript.nodejs ];
              CI = "1";
            }
          )
          ''
            ${playwright.setup}
            ${enterExample}
            mkdir -p "$out"
            export IBUS_WEB_TEST_REPORT=$out/results.json
            export IBUS_WEB_TEST_OUTPUT=$out/artifacts
            set -o pipefail
            timeout --kill-after=10 600 ${playwrightTest} 2>&1 | tee "$out/output.txt"
          '';
    in
    {
      packages.demo = page;
      packages.playwright-integration = integration;
      ibusWeb.testing.extendedChecks.playwright = integration;

      apps.demo = {
        type = "app";
        program = lib.getExe (
          pkgs.writeShellApplication {
            name = "ibus-web-demo";
            runtimeInputs = [
              typescript.nodejs
              pkgs.pnpm
              pkgs.git
            ];
            text = ''
              root=$(git rev-parse --show-toplevel 2>/dev/null) || {
                echo "Run this app inside the ibus-web checkout." >&2
                exit 1
              }
              cd "$root"
              if [ ! -f flake.nix ] || [ ! -f examples/demo/package.json ]; then
                echo "Run this app inside the ibus-web checkout." >&2
                exit 1
              fi

              ${exports env}

              if [ ! -d node_modules ]; then pnpm install --frozen-lockfile; fi
              pnpm --filter @ibus-web/example-demo... --filter '!@ibus-web/example-demo' run build
              pnpm --dir examples/demo exec vite --host 127.0.0.1 --port 5173 --strictPort "$@"
            '';
          }
        );
      };

      apps.keystroke-bench = {
        type = "app";
        program = lib.getExe (
          pkgs.writeShellApplication {
            name = "ibus-web-keystroke-bench";
            runtimeInputs = [ typescript.nodejs ];
            text = ''
              ${exports pageEnv}

              run_dir=$(mktemp -d)
              trap 'rm -rf "$run_dir"' EXIT
              cd "$run_dir"
              ${enterExample}

              export IBUS_WEB_KEYSTROKE_BENCH=1
              ${playwrightTest} "$@"
            '';
          }
        );
      };

      devshells.default.env = lib.mapAttrsToList (name: value: { inherit name value; }) env;

      checks.example-demo-smoke =
        pkgs.runCommand "ibus-web-example-demo-smoke"
          (
            pageEnv
            // {
              nativeBuildInputs = [ typescript.nodejs ];
            }
          )
          ''
            ${playwright.setup}
            ${enterExample}
            timeout --kill-after=10 90 node test/smoke.ts > "$out" 2>&1 || { cat "$out"; exit 1; }
            cat "$out"
          '';
    };
}
```

- [ ] **Step 4: Rename the package and its lockfile importer**

```bash
nix develop -c sed -i 's|"name": "@ibus-web/example-hangul"|"name": "@ibus-web/example-demo"|' examples/demo/package.json
nix develop -c sed -i 's|^  examples/hangul:$|  examples/demo:|' pnpm-lock.yaml
nix develop -c git grep -n 'examples/' -- pnpm-lock.yaml
```

Expected: one line, `  examples/demo:`.

- [ ] **Step 5: Serve the modules directory in Vite**

`examples/demo/vite.config.ts`:

```ts
// before
    for (const name of ["runtime", "host", "hangul"]) {
```

```ts
// after
    for (const name of ["runtime", "host", "modules"]) {
```

```ts
// before
              Object.fromEntries(["runtime", "host", "hangul"].map((name) => [name, resolve(root, name)])),
```

```ts
// after
              Object.fromEntries(["runtime", "host", "modules"].map((name) => [name, resolve(root, name)])),
```

```ts
// before
                for (const [name, directory] of Object.entries(directories))
                  await cp(directory, resolve(options.dir ?? "dist", "ibus-web", name), { recursive: true });
```

```ts
// after
                // The modules directory links to each distribution; the built page holds copies.
                for (const [name, directory] of Object.entries(directories))
                  await cp(directory, resolve(options.dir ?? "dist", "ibus-web", name), {
                    recursive: true,
                    dereference: true,
                  });
```

- [ ] **Step 6: Write the page**

In `examples/demo/index.html`:

```html
<!-- before -->
    <title>ibus-web Hangul</title>
```

```html
<!-- after -->
    <title>ibus-web demo</title>
```

```html
<!-- before -->
      <h1>Type Korean with ibus-web</h1>
      <p>Hangul runs in your browser. Use a US keyboard layout to try it.</p>
      <p id="how-to">
        Press the Hangul key or <kbd>Shift+Space</kbd> to toggle Hangul/Latin input. Type <kbd>gks</kbd> for 한. Press
        <kbd>F9</kbd> to convert to Hanja, then use digits, click a candidate, or use arrows and Enter. Click outside a
        field to commit its preedit.
      </p>
      <div class="toolbar">
        <label><input id="enabled" type="checkbox" checked disabled /> Enable ibus-web</label>
        <button id="restart" type="button" disabled>Restart engine</button>
      </div>
      <p role="status">
        Engine: <output id="engine">starting</output> · Storage: <output id="storage">starting</output> · Input mode:
        <output id="mode">—</output>
      </p>
```

```html
<!-- after -->
      <h1>Type with ibus-web</h1>
      <p>These input methods run in your browser. Use a US keyboard layout to try them.</p>
      <p id="how-to">
        Pick an input method, then type in either field; its keys work as they do on the desktop. Press
        <kbd>Ctrl+Space</kbd> to turn input methods off and back on. Click outside a field to commit its preedit.
      </p>
      <div class="toolbar">
        <label for="engine-picker">Input method</label>
        <select id="engine-picker" disabled>
          <option value="">Off</option>
        </select>
        <label><input id="enabled" type="checkbox" checked disabled /> Enable ibus-web</label>
        <button id="restart" type="button" disabled>Restart module</button>
      </div>
      <p role="status">
        Module: <output id="engine">starting</output> · Storage: <output id="storage">starting</output> · Input mode:
        <output id="mode">—</output>
      </p>
```

Replace `examples/demo/src/main.ts` with:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import {
  booleanVariant,
  createIbusWeb,
  int32Variant,
  stringVariant,
  type IbusWeb,
  type LogEntry,
  type Selection,
} from "ibus-web";
import { createPanel } from "ibus-web/panel";
import "ibus-web/panel/style.css";
import "./style.css";

type SettingsKey = Awaited<ReturnType<IbusWeb["settings"]["schemas"]>>[number]["keys"][number];
type SettingValue = Awaited<ReturnType<IbusWeb["settings"]["get"]>>;

const query = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const fields = [query<HTMLTextAreaElement>("#input"), query<HTMLInputElement>("#single-line")];
const picker = query<HTMLSelectElement>("#engine-picker");
const enabled = query<HTMLInputElement>("#enabled");
const state = query<HTMLOutputElement>("#engine");
const storage = query<HTMLOutputElement>("#storage");
const mode = query<HTMLOutputElement>("#mode");
const error = query<HTMLParagraphElement>("#error");
const logs = query<HTMLUListElement>("#log");
const restart = query<HTMLButtonElement>("#restart");
const form = query<HTMLFieldSetElement>("#settings");
const settingsState = query<HTMLOutputElement>("#settings-state");

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const logger = (entry: LogEntry) => {
  const item = document.createElement("li");
  item.textContent = `${entry.level}${entry.domain ? ` [${entry.domain}]` : ""}: ${entry.message}`;
  logs.append(item);
  while (logs.children.length > 100) logs.firstElementChild!.remove();
  logs.scrollTop = logs.scrollHeight;
};
const failure = (action: string, cause: unknown) => {
  error.textContent = `${action}: ${message(cause)}`;
  logger({ level: "error", message: error.textContent });
};

// The build serves every configured module under one directory, beside a map from module name to manifest.
const modulesUrl = new URL("/ibus-web/modules/", location.href);
const loadModules = async (): Promise<Record<string, URL>> => {
  const response = await fetch(new URL("modules.json", modulesUrl));
  if (!response.ok) throw new Error(`Module list fetch failed: ${response.status}`);
  const manifests = (await response.json()) as Record<string, string>;
  return Object.fromEntries(Object.entries(manifests).map(([name, path]) => [name, new URL(path, modulesUrl)]));
};

const modules = await loadModules();
const app = createIbusWeb({
  hostUrl: new URL("/ibus-web/host/worker/index.js", location.href),
  runtimeUrl: new URL("/ibus-web/runtime/ibus-runtime.js", location.href),
  modules,
  logger,
});
const panel = createPanel(app);
let detaches = fields.map((field) => app.attach(field));

// Every engine of every module, in manifest order; the picker's option values index it.
const choices: Selection[] = [];
let last: Selection | undefined,
  shownSettings: string | undefined,
  restarting = false;
const states = new Map<string, string>();
const storages = new Map<string, { text: string; reported: boolean }>();

const current = () => (app.selection ?? last)?.module;
const render = () => {
  const module = current();
  state.textContent = (module && states.get(module)) ?? "starting";
  storage.textContent = (module && storages.get(module)?.text) ?? "starting";
  restart.disabled = restarting || !["ready", "busy"].includes(state.textContent ?? "");
};

app.addEventListener("modulestate", ({ detail }) => {
  states.set(detail.module, detail.state);
  if (detail.state === "starting" || detail.state === "restarting")
    storages.set(detail.module, { text: "starting", reported: false });
  else if (detail.state === "ready" && !storages.get(detail.module)?.reported)
    // Writable startup has no storage event; this is a UI default, not a received state.
    storages.set(detail.module, { text: "persistent (writable)", reported: false });
  render();
});
app.addEventListener("storage", ({ detail }) => {
  storages.set(detail.module, { text: `${detail.state}: ${detail.message}`, reported: true });
  render();
});
app.addEventListener("selectionchange", ({ detail }) => {
  if (detail) last = detail;
  const index = detail
    ? choices.findIndex((choice) => choice.module === detail.module && choice.engine === detail.engine)
    : -1;
  picker.value = index < 0 ? "" : String(index);
  render();
  if (detail && detail.module !== shownSettings) showSettings(detail.module);
});
app.addEventListener("panel", ({ detail }) => {
  if (detail._tag === "hide") mode.textContent = "—";
  if (detail._tag !== "record") return;
  const record = detail.record;
  const property =
    record._tag === "RegisterProperties"
      ? record.properties.properties.find((property) => property.key === "InputMode")
      : record._tag === "UpdateProperty" && record.property.key === "InputMode"
        ? record.property
        : undefined;
  if (property) mode.textContent = property.symbol.text;
});

const toggle = () => {
  const target = app.selection ? undefined : last;
  void (target ? app.select(target.module, target.engine) : app.deselect()).catch((cause: unknown) =>
    failure("Switching failed", cause),
  );
};
// Capturing on the window runs before the fields' own listeners, so no engine sees the shortcut.
const shortcut = (event: KeyboardEvent) => {
  if (event.code !== "Space" || !event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.type === "keydown" && !event.repeat) toggle();
};
window.addEventListener("keydown", shortcut, true);
window.addEventListener("keyup", shortcut, true);

picker.addEventListener("change", () => {
  const choice = picker.value === "" ? undefined : choices[Number(picker.value)];
  void (choice ? app.select(choice.module, choice.engine) : app.deselect()).catch((cause: unknown) =>
    failure("Switching failed", cause),
  );
});
enabled.addEventListener("change", () => {
  if (enabled.checked) detaches = fields.map((field) => app.attach(field));
  else {
    for (const detach of detaches) detach();
    detaches = [];
  }
});
restart.addEventListener("click", () => {
  const module = current();
  if (restarting || module === undefined) return;
  restarting = true;
  render();
  void app
    .debugRestart(module)
    .catch((cause: unknown) => failure("Restart failed", cause))
    .finally(() => {
      restarting = false;
      render();
    });
});

form.closest("form")!.addEventListener("submit", (event) => event.preventDefault());
// Every module shares the panel's schema; of it, the form shows only the setting the panel reads.
const panelSchema = "org.freedesktop.ibus.panel";
const panelKeys = new Set(["lookup-table-orientation"]);
const editable = new Set(["b", "i", "s"]);
const controls: { schema: string; key: SettingsKey; control: HTMLInputElement | HTMLSelectElement }[] = [];
const scalar = (value: SettingsKey["default"]) => ("value" in value ? String(value.value) : "");
const display = (control: HTMLInputElement | HTMLSelectElement, value: SettingValue) => {
  if (control instanceof HTMLInputElement && control.type === "checkbox")
    control.checked = value.value._tag === "b" && value.value.value;
  else control.value = scalar(value.value);
};
let settingsGeneration = 0,
  refreshing = false,
  disposed = false;

const refreshSettings = async () => {
  const module = shownSettings;
  if (refreshing || disposed || module === undefined) return;
  refreshing = true;
  try {
    for (const { schema, key, control } of controls) {
      if (control.disabled || control === document.activeElement) continue;
      const value = await app.settings.get(module, schema, key.name);
      if (!disposed && module === shownSettings && !control.disabled && control !== document.activeElement)
        display(control, value);
    }
  } finally {
    refreshing = false;
  }
};
const loadSettings = async (module: string, generation: number) => {
  const schemas = await app.settings.schemas(module);
  for (const schema of schemas) {
    const keys = schema.keys.filter(
      (key) => editable.has(key.type) && (schema.id !== panelSchema || panelKeys.has(key.name)),
    );
    for (const key of keys) {
      const label = document.createElement("label");
      label.className = "setting";
      const title = document.createElement("span");
      title.textContent = key.summary || key.name;
      const control = key.choices ? document.createElement("select") : document.createElement("input");
      control.id = `setting-${key.name}`;
      control.name = key.name;
      if (control instanceof HTMLSelectElement) {
        for (const choice of key.choices!) control.add(new Option(choice, choice));
      } else {
        control.type = key.type === "b" ? "checkbox" : key.type === "i" ? "number" : "text";
        control.required = key.type === "i";
        if (key.range) {
          control.min = scalar(key.range.min);
          control.max = scalar(key.range.max);
        }
      }
      const help = document.createElement("small");
      help.id = `${control.id}-help`;
      help.textContent = `${key.description ? `${key.description} ` : ""}Default: ${scalar(key.default)}${key.range ? `; range: ${scalar(key.range.min)}–${scalar(key.range.max)}` : ""}`;
      control.setAttribute("aria-describedby", help.id);
      const value = await app.settings.get(module, schema.id, key.name);
      if (generation !== settingsGeneration) return;
      display(control, value);
      controls.push({ schema: schema.id, key, control });
      control.addEventListener("change", () => {
        if (!control.reportValidity()) return;
        const value: SettingValue =
          key.type === "b"
            ? booleanVariant((control as HTMLInputElement).checked)
            : key.type === "i"
              ? int32Variant(Number(control.value))
              : stringVariant(control.value);
        control.disabled = true;
        settingsState.textContent = "Saving…";
        void app.settings.set(module, schema.id, key.name, value).then(
          () => {
            control.disabled = false;
            settingsState.textContent = "Saved; applies live and across tabs.";
          },
          (cause: unknown) => {
            control.disabled = false;
            settingsState.textContent = "Save failed";
            failure(`Could not save ${key.name}`, cause);
            void refreshSettings().catch((cause: unknown) => failure("Settings refresh failed", cause));
          },
        );
      });
      label.append(title, control, help);
      form.append(label);
    }
  }
  form.disabled = false;
  settingsState.textContent = "Settings ready; changes save automatically.";
};
const showSettings = (module: string) => {
  shownSettings = module;
  const generation = ++settingsGeneration;
  controls.length = 0;
  form.disabled = true;
  form.replaceChildren(form.querySelector("legend")!);
  settingsState.textContent = "Loading settings…";
  void loadSettings(module, generation).catch((cause: unknown) => {
    if (generation !== settingsGeneration) return;
    settingsState.textContent = "Settings unavailable";
    failure("Settings initialization failed", cause);
  });
};
const refresh = () => {
  void refreshSettings().catch((cause: unknown) => {
    if (!disposed) failure("Settings refresh failed", cause);
  });
};
window.addEventListener("focus", refresh);
// The facade owns cross-tab updates; public reads also refresh visible, unfocused form controls.
const refreshTimer = setInterval(() => {
  if (document.visibilityState === "visible") refresh();
}, 1000);

const start = async () => {
  for (const module of Object.keys(modules)) {
    const group = document.createElement("optgroup");
    group.label = module;
    for (const engine of await app.engines(module)) {
      group.append(new Option(engine.displayName, String(choices.length)));
      choices.push({ module, engine: engine.name });
    }
    picker.append(group);
  }
  const first = choices[0];
  if (!first) throw new Error("No modules are configured");
  picker.disabled = false;
  showSettings(first.module);
  await app.select(first.module, first.engine);
  enabled.disabled = false;
};
void start().catch((cause: unknown) => failure("Engine initialization failed", cause));

const dispose = () => {
  disposed = true;
  clearInterval(refreshTimer);
  window.removeEventListener("focus", refresh);
  window.removeEventListener("keydown", shortcut, true);
  window.removeEventListener("keyup", shortcut, true);
  panel.dispose();
  void app.dispose().catch((cause: unknown) => failure("Cleanup failed", cause));
};
window.addEventListener("pagehide", dispose, { once: true });
if (import.meta.hot) import.meta.hot.dispose(dispose);
```

Replace `examples/demo/README.md` with:

````markdown
# The demo

One page for every input method module the repository builds. Its picker lists each module's engines.

From inside the checkout, run:

```sh
nix run .#demo
```

The default address is `http://127.0.0.1:5173`. Pass Vite options after `--` to use another port:

```sh
nix run .#demo -- --port 5174
```

Inside `nix develop`, `pnpm --dir examples/demo dev --port 5174` uses the same runtime and module assets. Pick an input
method in the picker; <kbd>Ctrl+Space</kbd> turns input methods off and back on. The checkbox turns ibus-web handling on
or off. While a module starts, the fields accept native input.

A module joins the demo when its Nix module sets `ibusWeb.demo.modules.<name>` to its distribution. The page opens on the
default engine of the first module in name order. Each module's end-to-end tests are in `test/e2e/<name>.spec.ts`, with
their helpers beside them.
````

- [ ] **Step 7: Group the Playwright specs by module**

Create `examples/demo/test/e2e/hangul.ts` with the Hangul helpers:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, type Page } from "playwright/test";

export async function hangul(page: Page) {
  await page.locator("#input").click();
  await expect(page.locator("#mode")).toHaveText("EN");
  await page.keyboard.press("Shift+Space");
  await expect(page.locator("#mode")).toHaveText("한");
}

export async function keyboardSetting(page: Page, value: string) {
  await page.locator("#setting-hangul-keyboard").fill(value);
  await page.locator("h1").click();
  await expect(page.locator("#settings-state")).toContainText("Saved");
  await expect(page.locator("#setting-hangul-keyboard")).toBeEnabled();
}
```

In `examples/demo/test/e2e/fixtures.ts`, replace everything from `export async function openDemo` to the end with the module-neutral helper (Hangul's helpers moved above):

```ts
// before
export async function openDemo(page: Page) {
  await page.goto("/");
  await expect(page.locator("#engine")).toHaveText("ready");
  await expect(page.locator("#setting-hangul-keyboard")).toHaveValue("2");
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
}
export async function hangul(page: Page) {
  await page.locator("#input").click();
  await expect(page.locator("#mode")).toHaveText("EN");
  await page.keyboard.press("Shift+Space");
  await expect(page.locator("#mode")).toHaveText("한");
}
export async function keyboardSetting(page: Page, value: string) {
  await page.locator("#setting-hangul-keyboard").fill(value);
  await page.locator("h1").click();
  await expect(page.locator("#settings-state")).toContainText("Saved");
  await expect(page.locator("#setting-hangul-keyboard")).toBeEnabled();
}
```

```ts
// after
export async function openDemo(page: Page) {
  await page.goto("/");
  await expect(page.locator("#engine")).toHaveText("ready");
  await expect(page.locator("#settings-state")).toHaveText("Settings ready; changes save automatically.");
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
}
```

In `examples/demo/test/e2e/hangul.spec.ts`, replace the import line with the imports and the check `openDemo` used to make:

```ts
// before
import { test, expect, hangul } from "./fixtures.ts";
```

```ts
// after
import { test, expect, openDemo } from "./fixtures.ts";
import { hangul, keyboardSetting } from "./hangul.ts";

test.beforeEach(async ({ page }) => {
  await expect(page.locator("#setting-hangul-keyboard")).toHaveValue("2");
});
```

then append, after its last test, a blank line, the `test("3-set changes composition immediately, …")` block from `settings.spec.ts` unchanged (everything from `test(` to its closing `});`), a blank line, and:

```ts
test("the picker lists Hangul, and Ctrl+Space turns input methods off and back on", async ({ page }) => {
  await expect(page.locator("#engine-picker option:checked")).toHaveText("Hangul");
  await hangul(page);
  await page.keyboard.type("gks");
  await page.keyboard.press("Control+Space");
  await expect(page.locator("#engine-picker")).toHaveValue("");
  await expect(page.locator("#input")).toHaveValue("한");
  await page.keyboard.type("gks");
  await expect(page.locator("#input")).toHaveValue("한gks");
  await expect(page.locator("[data-ibus-preedit]").filter({ hasText: /[가-힣]/ })).toHaveCount(0);
  await page.keyboard.press("Control+Space");
  await expect(page.locator("#engine-picker option:checked")).toHaveText("Hangul");
  await expect(page.locator("#engine")).toHaveText("ready");
});
```

and remove the merged file:

```bash
nix develop -c git rm -q examples/demo/test/e2e/settings.spec.ts
```

In `examples/demo/test/e2e/keystroke.bench.ts`:

```ts
// before
import { test, expect, hangul } from "./fixtures.ts";
```

```ts
// after
import { test, expect } from "./fixtures.ts";
import { hangul } from "./hangul.ts";
```

- [ ] **Step 8: Update the docs**

`README.md`:

```markdown
<!-- before -->
Open http://127.0.0.1:5173, press Shift+Space to switch to Hangul, type `gks` for 한, and press F9 for Hanja
candidates. The first build compiles the patched Emscripten toolchain, GLib and the engine, which takes a while.
[examples/hangul](examples/hangul/README.md) has the demo's other options.
```

```markdown
<!-- after -->
Open http://127.0.0.1:5173. The page opens on Hangul: press Shift+Space to switch to Hangul input, type `gks` for 한,
and press F9 for Hanja candidates. The picker lists every engine the repository builds, and Ctrl+Space turns input
methods off and back on. The first build compiles the patched Emscripten toolchain, GLib and the engines, which takes a
while. [examples/demo](examples/demo/README.md) has the demo's other options.
```

and in its layout table, the `examples/` row's description `the Hangul demo and its end-to-end tests` becomes `the demo of every module and its end-to-end tests`.

`docs/README.md`: the `examples/hangul/README.md` row becomes

```markdown
| [`examples/demo/README.md`](../examples/demo/README.md)                               | Running the demo and adding a module to it                               |
```

and in the `core.md` row, `recovery and the Hangul demo` becomes `recovery and the demo`.

`docs/core.md`:

```markdown
<!-- before -->
`Effect.scoped` program. The [Hangul example](../examples/hangul/src/main.ts) provides
```

```markdown
<!-- after -->
`Effect.scoped` program. The [demo](../examples/demo/src/main.ts) provides
```

```markdown
<!-- before -->
The production demo is [examples/hangul](../examples/hangul/README.md). From the checkout:
```

```markdown
<!-- after -->
The production demo is [examples/demo](../examples/demo/README.md), one page for every
module in `ibusWeb.demo.modules`. From the checkout:
```

```markdown
<!-- before -->
is the production build and `checks.example-hangul-smoke` its separate Chromium smoke. Preview
serves copied Brotli archives as opaque bytes without Content-Encoding: br.

Press Shift+Space to switch to Hangul, type gks for 한 and press F9 for Hanja
candidates. Preedit appears over the field until committed. The page uses the
facade, candidate/property panel and metadata-driven persistent settings form;
its attachment control leaves native input usable while disabled or starting.
```

```markdown
<!-- after -->
is the production build and `checks.example-demo-smoke` its separate Chromium smoke. Preview
serves copied Brotli archives as opaque bytes without Content-Encoding: br. The build
serves every module under `/ibus-web/modules/<name>/`, beside a `modules.json` map from
module name to manifest that the page reads.

The page lists every engine of every module through `engines(module)` in its picker
and opens on the first module's default engine. Ctrl+Space, which the page binds
itself, toggles between `deselect()` and the last selection. For Hangul, press
Shift+Space to switch to Hangul input, type gks for 한 and press F9 for Hanja
candidates. Preedit appears over the field until committed. The page uses the
facade, candidate/property panel and a metadata-driven persistent settings form for
the selected module; its attachment control leaves native input usable while
disabled or starting.
```

`docs/testing.md`:

```markdown
<!-- before -->
`packages.demo` builds examples/hangul; `checks.example-hangul-smoke` separately loads that built
```

```markdown
<!-- after -->
`packages.demo` builds examples/demo; `checks.example-demo-smoke` separately loads that built
```

```markdown
<!-- before -->
preview configuration with COOP/COEP and runs eight trusted-input specs in each of
Chromium, Firefox and WebKit (24 total). It covers real Hangul composition, visible
preedit without value/input leakage, focused native undo, separate blur commit,
Hanja paging/click/digit selection, password exclusion, actual Worker restart,
native Space reset ordering, and 3f settings changes across live contexts, tabs
and reload. It fails on page errors or visible demo errors.
```

```markdown
<!-- after -->
preview configuration with COOP/COEP and runs nine trusted-input tests in each of
Chromium, Firefox and WebKit (27 total). The specs are grouped by module, in
`examples/demo/test/e2e/<module>.spec.ts` with their helpers beside them. Hangul's
cover real composition, visible preedit without value/input leakage, focused native
undo, separate blur commit, Hanja paging/click/digit selection, password exclusion,
actual Worker restart, native Space reset ordering, 3f settings changes across live
contexts, tabs and reload, and the picker with its Ctrl+Space toggle, which leaves
plain input while deselected. It fails on page errors or visible demo errors.
```

`docs/tooling.md`: in the workspace table, `` `@ibus-web/example-hangul`, with its end-to-end tests `` becomes `` `@ibus-web/example-demo`, with its end-to-end tests ``; and

```markdown
<!-- before -->
- **`nix run .#demo`** serves the Hangul demo ([examples/hangul](../examples/hangul/README.md)).
```

```markdown
<!-- after -->
- **`nix run .#demo`** serves the demo of every module ([examples/demo](../examples/demo/README.md)).
```

`docs/ibus-web.md`:

```markdown
<!-- before -->
The built [demo](../examples/hangul/README.md) shows the panel, settings form,
restart and attachment controls.
```

```markdown
<!-- after -->
The built [demo](../examples/demo/README.md) shows the engine picker and a
deselect shortcut, the panel, settings form, restart and attachment controls.
```

`docs/specs/2026-09-26-ibus-web-design.md`, the repository tree:

```text
before: ├─ examples/hangul/                the Hangul demo and its end-to-end tests
after:  ├─ examples/demo/                  the demo of every module and its end-to-end tests
```

- [ ] **Step 9: Stage the new files, format and check names**

```bash
nix develop -c git add examples/demo engines/hangul/module.nix pnpm-lock.yaml
nix develop -c oxfmt examples/demo README.md docs/README.md docs/core.md docs/ibus-web.md docs/testing.md docs/tooling.md docs/specs/2026-09-26-ibus-web-design.md
nix develop -c git grep -n -i 'hangul' -- examples/demo ':!examples/demo/test'
nix develop -c git grep -n -E 'examples/hangul|example-hangul' -- . ':!docs/plans' ':!docs/specs/2026-10-08-m2-1-table-engine.md'
```

Expected: both greps print nothing (the demo's code, Nix, page and README name no module; only its tests do).

- [ ] **Step 10: Build the page and run its checks**

```bash
nix develop -c pnpm install --frozen-lockfile
nix develop -c pnpm -r run build
nix develop -c hk check --all -S tsc -S oxlint -S links -S nixfmt
nix build -L .#checks.x86_64-linux.example-demo-smoke .#checks.x86_64-linux.tools-bundle-scan
nix build -L .#playwright-integration
jq .stats result/results.json && rm result
```

Expected: tsc, oxlint, links and nixfmt pass; the smoke prints `Demo smoke passed: …`; the bundle scan passes; `playwright-integration` reports `"expected": 27, "unexpected": 0` (nine tests in each of three browsers). If the first build fails with a hash mismatch for the pnpm dependencies, set `hash` in `modules/typescript/workspace.nix`'s `pnpmDeps` to the `got:` value, stage that file too, and build again.

- [ ] **Step 11: Check the built page holds real files**

```bash
nix build .#demo
ls result/ibus-web/modules && cat result/ibus-web/modules/modules.json && test -f result/ibus-web/modules/hangul/manifest.json && test ! -L result/ibus-web/modules/hangul
rm result
```

Expected: `hangul  modules.json`, then `{"hangul":"./hangul/manifest.json"}`, and the tests succeed.

- [ ] **Step 12: Commit**

```bash
nix develop -c git add examples/demo engines/hangul/module.nix pnpm-lock.yaml README.md docs/README.md docs/core.md \
  docs/ibus-web.md docs/testing.md docs/tooling.md docs/specs/2026-09-26-ibus-web-design.md
nix develop -c git commit -m "feat(demo): serve every module's engines from one demo" -- \
  examples/hangul examples/demo engines/hangul/module.nix pnpm-lock.yaml README.md docs/README.md docs/core.md \
  docs/ibus-web.md docs/testing.md docs/tooling.md docs/specs/2026-09-26-ibus-web-design.md
```

(Add `modules/typescript/workspace.nix` to both lists if Step 10 changed it.)

---

### Task 5: Verify the branch

**Files:** none changed, unless a check finds a fault; then fix it in the task's own files and amend nothing: make a new commit with the fitting type and scope.

- [ ] **Step 1: Generated files are current**

```bash
nix run .#write-files
git status --short
```

Expected: `git status` lists nothing of this branch's (no generated-file drift; `PROTOCOL.md`, `protocol.h`, `ci.yml` and `pnpm-workspace.yaml` unchanged).

- [ ] **Step 2: The default gates**

```bash
nix flake check -L
```

Expected: success.

- [ ] **Step 3: The extended gates**

```bash
nix build .#integration-checks -L
```

Expected: success, including `playwright-integration` (27 passed).

- [ ] **Step 4: Every hk step over the whole tree**

```bash
nix develop -c hk check --all
```

Expected: every step `✔` (actionlint, links, clang-format, nixfmt, tsconfig-extends, oxlint, pkl-format, tsc, oxfmt, reuse, shfmt).

- [ ] **Step 5: Leftover names**

```bash
nix develop -c git grep -n -w -E 'EngineManifest|EngineRegistry|enginestate|example-hangul' -- . ':!docs/plans'
nix develop -c git grep -n 'examples/hangul' -- . ':!docs/plans' ':!docs/specs/2026-10-08-m2-1-table-engine.md'
```

Expected: nothing.

- [ ] **Step 6: Report**

List each command above with its result. Name any check that failed or that you could not run; don't report it as passing.

---

## Self-review

**Spec coverage (phase 1 of "Delivery"):**

| Spec requirement | Task |
| --- | --- |
| Rename the manifest type, registry, facade `modules`, `select`/`unload`/`debugRestart`, `modulestate`, `module` in log and panel events | 1 (rename), 3 (new signatures) |
| `engines/<name>/`, `ibusWeb.engines`, `@ibus-web/engine-<name>` keep their names | 1–4 touch none of them |
| Manifest `engines: EngineDescriptor[]`, module `keyboard` removed; non-empty, unique names; unknown keys rejected; first is default | 2 |
| Hangul's manifest: `hangul`, "Hangul", `["ko"]`, today's keyboard | 2 |
| `mkEngineManifest` takes descriptors, or a JSON file from another derivation | 2 |
| `select(module, engine?)`; unknown module or engine rejected before anything changes | 3 (router, facade, tests) |
| Switching engine within a module reuses its Worker; drained, reset; new context with `CreateEngine{engine}` | 3 (`replace` in the router; switching test) |
| Keyboard policy is the active engine's | 2 (per-context engine), 3 (test with two engines) |
| `override(adapter, …)` takes the optional engine | 3 |
| `deselect()`; compositions finish; Workers stay loaded | 3 |
| `engines(module)` without starting a Worker | 3 (registry, facade, tests) |
| `selection` and `selectionchange` | 3 |
| No built-in hotkeys | 3 keeps the empty registry; 4 binds the demo's own |
| Protocol and core unit tests: descriptors decode and reject duplicates; reuse of the Worker; unknown engine; `deselect`; override with an engine; keyboard policy; `selectionchange` | 2, 3 |
| `examples/hangul` → `examples/demo` (`@ibus-web/example-demo`), picker via `engines(module)`, deselect toggle, tests grouped by module, `nix run .#demo`, `packages.demo`, `example-demo-smoke` | 4 |
| Docs updated with the code | 1–4, each in its own task |

**Placeholder scan:** none; every code step carries its code, and every check its command and expected result.

**Type consistency:** `Selection`, `KeyboardPolicy`, `ModuleSnapshot.keyboards`, `KeyContext.engine`, `ModuleRegistryService.engines`, `RouterService.selectionChanges`, `IbusWebEventMap.selectionchange` are named the same in every task that uses them. Plans B and C rely on `EngineDescriptor`, `ModuleManifest`, `mkEngineManifest { engines = <JSON file>; }`, `ibusWeb.demo.modules.<name>` and `examples/demo/test/e2e/<module>.spec.ts`, all produced here.
