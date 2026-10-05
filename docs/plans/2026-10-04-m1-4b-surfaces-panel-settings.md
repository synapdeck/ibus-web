# M1.4b: the textarea adapter, the panel, settings and the demo — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On top of M1.4a's keystroke path, a page gets everything a user sees: a textarea/input adapter
whose preedit is an overlay at the caret and whose commits are single undo steps, `@ibus-web/panel` with
the Hanja candidate window, auxiliary text and a property menu, settings that persist in the page's own
IndexedDB database and stay in sync across Workers and tabs, the `ibus-web` facade package hosts
install, and the full demo you run with `nix run .#demo`. Playwright suites drive the demo with trusted
keyboard events in Chromium, Firefox and WebKit, and the lookup table's visible page decodes within the
spec's 0.5 ms.

**Architecture:** Settings metadata is generated at build time from each engine's compiled schemas into a
`settings.json` beside its manifest; `@ibus-web/core`'s `SettingsSource` becomes an IndexedDB persister
(`gsettings` database) with a `BroadcastChannel`, replaceable by hosts. `@ibus-web/protocol` gains a lazy
lookup-table decoder that walks the `av` of candidates by framing offsets and decodes only the visible
page. The textarea adapter renders preedit in an overlay positioned by a mirror element, applies each
reply's records as one undo step, and the panel consumes core's `PanelEvents` through the facade only.
`ibus-web` wraps core in a `ManagedRuntime` with Promise methods, `EventTarget` events and a `logger`
option, and re-exports the Effect surface at `ibus-web/effect`. The demo becomes the reference host page
and the Playwright suites' target.

**Tech Stack:** TypeScript 7, Effect 4.0.0, `@ibus-web/{protocol,core,worker-host}`, GLib (through a WebAssembly build tool) for schema
metadata, IndexedDB and `BroadcastChannel`, Vite 8 (dev server and
production build), Playwright 1.63 (nixpkgs' `playwright-driver` with Chromium headless shell, Firefox and
WebKit), Vitest 5, Nix.

## Global constraints

Every constraint of M1.4a's plan (`docs/plans/2026-10-04-m1-4a-keystroke-path.md`, "Global constraints")
applies, and:

- **Preedit is never document content** (spec §7.2): a host's value, undo history and `input` events never contain it.
- **The panel uses only the facade's public API** (spec §7.3), so it is framework-free and replaceable.
- **The page never opens an engine's databases**, and **the Worker host never opens `gsettings`** (spec §7.1.4, §5.6).
- Page bundles contain no Worker, runtime or Emscripten code (spec §9.2); Task 8's scan enforces it.
- Timing in checks is one-sided only; tight figures come from `nix run` apps (`protocol-bench`, `keystroke-bench`), as M1.2 settled.

## Decisions fixed here

**Settings metadata** (`settings.json`, schema `SettingsMetadata` in `@ibus-web/protocol`):

```ts
{
  schemas: Array<{
    id: string;
    path: string;
    keys: Array<{
      name: string;
      type: string /* GVariant type */;
      default: GVariantValue;
      summary?: string;
      description?: string;
      range?: { min: GVariantValue; max: GVariantValue };
      choices?: string[];
    }>;
  }>;
}
```

Generated in Nix from the engine's compiled schemas directory (its `settingsSchemaDir`) by
`tools/gschema/metadata.c`, a small program compiled for WebAssembly against `pkgsWasm.glib` and
json-glib (`ibusWeb.testing.jsonGlib`) and run under Node: for each schema the manifest's
`settingsSchemas` names it asks GLib itself (`g_settings_schema_source_lookup`, `g_settings_schema_get_path`,
`g_settings_schema_list_keys`, `g_settings_schema_key_get_value_type`, `_get_default_value`, `_get_range`,
`_get_summary`, `_get_description`) and prints each default and range bound as its type plus base64
GVariant normal-form bytes; `tools/gschema/metadata.ts` decodes those with `decodeValue` and writes
`settings.json`. GLib is the authority on the schemas, so nothing parses XML or GVariant text. The manifest gains
`settingsMetadata: { url: string; size: number }`. Schemas without a fixed `path` (relocatable) are
rejected at build time, as the runtime rejects them.

**The `gsettings` database** (one per origin, shared by every engine): object store `values`, key
`[schemaPath, keyName]`, value `{ type: string, bytes: ArrayBuffer }` (GVariant normal form of the value,
never a `Blob`). Before starting a Worker, the page reads every key of the engine's schemas and sends
the ones present as `Init`'s snapshot (keyed by schema id via the metadata). On a `SettingWritten`
record or a change through the settings API: if the value equals the key's default, delete the record
(so a later default change reaches users who never chose otherwise), else put it; send `SettingChanged`
to the page's other live Workers whose engines use that schema; post `{ schemaPath, key, type, bytes |
null }` on `BroadcastChannel("ibus-web:gsettings")`. Other tabs forward received changes to their own
Workers as `SettingChanged` without writing. Concurrent writers: last write wins per record; every tab
converges on the value in the last broadcast it received, and the next `Init` reads the database.

**Lazy lookup tables.** `decodeLookupTableRecord(bytes)` in `@ibus-web/protocol` returns
`{ pageSize, cursorPos, cursorVisible, round, orientation, count, visible: () => { candidates: IBusText[]; labels: IBusText[] }, page(index) }`:
it decodes the fixed fields and the `av` framing offsets eagerly, and decodes candidates (through the
same strict decoder and schemas) only for the requested page; the record's bytes are retained. The
panel decodes the visible page on arrival and others on paging. The full `decodeRecord` keeps working
for every other caller.

**Commits and undo.** The adapter applies a reply's records inside `batch()`; a commit or a surrounding
deletion uses `document.execCommand("insertText"/"delete")` while the element is focused, which browsers
record as an undoable edit with an `input` event of the right `inputType`; consecutive edits in one batch
are merged by applying their net change as one `insertText` over the affected range. When `execCommand`
is unavailable or the element isn't focused, it falls back to `setRangeText` plus a synthetic `input`
event (not undoable natively; recorded as a known gap). Spec §7.2.2 changes accordingly.

**The preedit overlay.** A positioned element over the input, its text styled from the preedit's IBus
attributes (underline; foreground/background `0xRRGGBB`; ibus-hangul marks the syllable being composed
white on black), placed at the caret found with a mirror element (a hidden copy of the input's text and
box styles up to the caret). The input's own text stays unchanged; the caret's real position is kept
where the preedit would be inserted. `SetCursorLocation` reports the overlay caret's rectangle.

**The panel** (`@ibus-web/panel`): a candidate window anchored below (or above, if no room) the caret
rectangle, vertical or horizontal per the engine's table orientation, falling back to the panel schema's
`lookup-table-orientation` setting when the table says `System`; labels from the table or "1." … "9.",
"0.", "a." … "f."; the cursor's candidate highlighted when the cursor is visible; the auxiliary text as a
row; previous/next buttons sending `PageUp`/`PageDown`; wheel sending `CursorUp`/`CursorDown`; a click
sending `CandidateClicked` with the page-relative index; a property menu listing registered properties
(visible ones; toggles show their state; activating sends `PropertyActivate(key, newState)` only when
the state changes) and, as a compact indicator, the symbol of the first visible toggle or radio property that has one (ibus-hangul's 한/EN). Output is hidden on
`FocusOut` and on crashes (core's events).

**The facade** (`ibus-web`): `createIbusWeb(options) => IbusWeb` with `options = { hostUrl?, runtimeUrl,
engines: Record<name, manifestUrl>, settings?: SettingsSource, logger?: (entry) => void, logLevel?,
config? }`; methods `attach(element)`, `select(engine)`, `unload(engine)`, `settings.{schemas(engine),
get, set, reset}`, `dispose()`; events (`EventTarget`): `enginestate`, `storage`, `panel`, `log`. Subpaths:
`ibus-web` (facade), `ibus-web/effect` (core's services, layers, streams, tagged errors and adapters;
protocol's public schemas and types), `ibus-web/panel` (re-export), `ibus-web/worker` (the host Worker
script's URL only: `new URL("@ibus-web/worker-host/worker", import.meta.url)` resolved by the package's
`exports`, never its code). `effect` stays a peer dependency.

**WebKit.** `ibusWeb.testing.playwright.browsers` enables WebKit. If it can't run in the Nix sandbox, the
WebKit project runs in CI with `nix develop -c` (spec R13) and the checks run Chromium and Firefox; the
outcome is recorded in `docs/testing.md`.

## File map

| Path                                                                                                             | Responsibility                                          | Task |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ---- |
| `tools/gschema/*`, `modules/engines/settings-metadata.nix`, `packages/protocol/src/settings.ts`, manifest schema | settings metadata                                       | 1    |
| `packages/core/src/settings/{persister,broadcast,api}.ts`, tests                                                 | IndexedDB persister, cross-tab sync, settings API       | 2    |
| `packages/protocol/src/messages/lookup.ts`, tests, `test/bench/*`                                                | lazy lookup tables                                      | 3    |
| `packages/core/src/adapters/{textarea,overlay,mirror,undo}.ts`, tests                                            | the full textarea/input adapter                         | 4    |
| `packages/panel/**`                                                                                              | the panel                                               | 5    |
| `packages/ibus-web/**`                                                                                           | the facade and subpaths                                 | 6    |
| `packages/demo/**`, `modules/demo.nix`                                                                           | the full demo                                           | 7    |
| `tests/playwright/**`, `modules/testing/default.nix`, `modules/playwright.nix`, `tools/bundle-scan/*`            | Playwright suites, keystroke bench, WebKit, bundle scan | 8    |
| `docs/*`, spec                                                                                                   | docs                                                    | 9    |

---

### Task 1: Settings metadata from the schemas

**Files:** `tools/gschema/{metadata.c,metadata.ts,metadata.test.ts,tsconfig.json}`, `modules/engines/settings-metadata.nix`, `modules/engines/manifest.nix` (`settingsMetadata`), `packages/protocol/src/{settings,manifest}.ts` and tests, `engines/hangul/package.nix`.

- [ ] **Step 1: Failing tests:** on a fixture schema (compiled with `pkgsWasm.glib`'s `glib-compile-schemas`) with string, boolean, integer-with-range, enum-like `choices` and a summary/description, `settings.json` decodes with `SettingsMetadata` and every default equals GLib's (round-tripped through `decodeValue`); a relocatable schema fails the build; Hangul's metadata lists `org.freedesktop.ibus.engine.hangul` (path `/org/freedesktop/ibus/engine/hangul/`) with `hangul-keyboard` (`s`, default `'2'`, its choices), `hanja-keys`, `initial-input-mode`, `auto-reorder`, `preedit-mode`, and `org.freedesktop.ibus.panel` with `lookup-table-orientation` (`i`, default 1).
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement** per the Decisions: `metadata.c` (built like the worker-host constants program, linked with `pkgsWasm.glib` and json-glib, run under Node on the compiled schemas directory) and `metadata.ts`.
- [ ] **Step 4:** `nix build -L .#checks.x86_64-linux.{protocol,engine-manifest,hangul-host,hk}` and the Hangul distribution (read its `settings.json`).
- [ ] **Step 5: Commit** `feat: generate settings metadata from engines' GSettings schemas`.

### Task 2: The settings persister

**Files:** `packages/core/src/settings/{persister,broadcast,api}.ts`, `src/services/settings.ts` (default layer becomes the persister), `test/browser/settings*.test.ts`.

**Interfaces (produced):** `indexedDbSettings(): Layer<SettingsSource>`; `SettingsApi` with `schemas(engine)`, `get(engine, schemaId, key)`, `set(engine, schemaId, key, value)`, `reset(...)`, `changes: Stream<SettingChange>` (includes engine-written values).

- [ ] **Step 1: Failing tests** (browser mode, real IndexedDB, the fake Worker from M1.4a and the real host for one case): `Init`'s snapshot holds exactly the stored keys; a `SettingWritten` is stored and sent as `SettingChanged` to a second live Worker using the schema, and not echoed to its writer; a value equal to the default deletes the record; a second page context (another `BroadcastChannel` on the same origin, in the same test) receives the change and forwards it to its Worker without writing; values are stored as `ArrayBuffer`s; the API's `changes` stream sees both API and engine writes; a host-supplied `SettingsSource` layer replaces the persister entirely (the database is never opened).
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `nix build -L .#checks.x86_64-linux.{core,core-browser,hk}`.
- [ ] **Step 5: Commit** `feat(core): persist settings in IndexedDB and share them across Workers and tabs`.

### Task 3: Lazy lookup tables

**Files:** `packages/protocol/src/messages/lookup.ts`, `src/index.ts`, `test/messages/lookup.test.ts`, `test/bench/lookup-table.test.ts`.

- [ ] **Step 1: Failing tests:** for random tables (`it.prop`, fixed seed; up to 600 candidates, page sizes 1–16, cursor anywhere) every `page(i)` equals the corresponding slice of `decodeRecord`'s full table; malformed framing in a candidate not yet decoded is reported when that page is decoded (and the eager part still validates the `av`'s framing); the bench prints framed-record → visible-page medians next to the full decode's.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.** The GVariant layer gains a function returning an array's element boundaries without decoding elements.
- [ ] **Step 4:** `nix run .#protocol-bench`: record the visible-page median and p99; the target is under 0.5 ms for 500 candidates. `nix build -L .#checks.x86_64-linux.{protocol,protocol-parity,hk}`.
- [ ] **Step 5: Commit** `feat(protocol): decode lookup tables a page at a time`.

### Task 4: The textarea and input adapter

**Files:** `packages/core/src/adapters/{textarea,overlay,mirror,undo}.ts`, `test/browser/adapter*.test.ts`.

- [ ] **Step 1: Failing tests** (browser mode): a preedit renders in the overlay at the caret (its rectangle within a few pixels of a mirror-measured caret, for single-line input, multi-line textarea, scrolled textarea and right-to-left text) and never appears in `value`; attributes render (underline; white-on-black current syllable); commits fire one `input` event each with `inputType` `insertText`; a batch with `DeleteSurroundingText` then `CommitText` is one undo step (`document.execCommand("undo")` restores the text before the batch); the fallback path without focus uses `setRangeText`; `replayKey` for Backspace, Delete, Enter (textarea only), arrows and printable keys edits as the browser would; resets fire on caret moves by pointer and on external `value` changes.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `nix build -L .#checks.x86_64-linux.{core-browser,hk}`.
- [ ] **Step 5: Commit** `feat(core): render preedit in an overlay and commit as single undo steps`.

### Task 5: The panel

**Files:** `packages/panel/{package.json,tsconfig*.json,tsdown.config.ts,src/*,test/browser/*}`, `module.nix` (`checks.panel`).

- [ ] **Step 1: Failing tests** (browser mode, a facade stub emitting panel events): the candidate window shows the visible page with labels, highlights the cursor's candidate only when `cursorVisible`, follows orientation (table, or the panel schema's setting for `System`), sits below the caret or above it when there is no room; clicking the third candidate on page 2 sends `CandidateClicked(2, 1, 0)`; previous/next send `PageUp`/`PageDown`; the wheel sends `CursorUp`/`CursorDown`; auxiliary text renders in its row; the property menu lists visible properties, toggles send `PropertyActivate` only on change, and the indicator shows the symbol of the first visible `Toggle` or `Radio` property that has one, so no engine's property names are special-cased; everything hides on `FocusOut` and crash events; pages beyond the visible one are decoded only when shown (spy on the lazy decoder).
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement** with the DOM only (no framework), styles in a stylesheet the host can override (CSS custom properties).
- [ ] **Step 4:** `nix build -L .#checks.x86_64-linux.{panel,hk}`.
- [ ] **Step 5: Commit** `feat(panel): the candidate window, auxiliary text and property menu`.

### Task 6: The `ibus-web` facade

**Files:** `packages/ibus-web/{package.json,tsconfig*.json,tsdown.config.ts,src/{index,effect,panel,worker}.ts,test/*}`, `module.nix`.

**Mixed-surface integration:** Consume M1.4a Task 6b's editor-neutral asynchronous interface. Expose `attachAdapter(adapter, options?: { keyMode?: "sync" | "async" | "manual" }): () => void` and `keyAsync(adapter, event): Promise<AsyncKeyResult>` alongside native `attach(element)`. One facade instance must support normal inputs and asynchronous editor adapters on the same page, including sharing an engine. Preserve core's output ordering and fallback/cancellation ownership; do not add a page-global input mode or a CodeMirror dependency.

- [ ] **Step 1: Failing tests:** `createIbusWeb` starts nothing until `select`; `attach` returns a detach function; events fire as `CustomEvent`s with typed `detail`; `logger` receives entries at or above `logLevel`; `dispose()` terminates every Worker and detaches every surface; `ibus-web/effect` exports core's services and tagged errors and protocol's public schemas; `ibus-web/worker` exports a URL and its module graph contains no worker-host code (checked by bundling it with tsdown in the test and inspecting the output).
  - native and asynchronous editor-style adapters coexist through one facade; `manual` attachments leave keyboard capture to the editor; asynchronous dispatch never invokes the synchronous path; disposal settles outstanding asynchronous calls without duplicate edits.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `nix build -L .#checks.x86_64-linux.{ibus-web,core-browser,hk}`.
- [ ] **Step 5: Commit** `feat: the ibus-web facade and its subpath exports`.

### Task 7: The full demo

**Files:** `packages/demo/**`, `modules/demo.nix`.

The demo uses only `ibus-web` and `ibus-web/panel`, as a host would. It shows: a textarea and a
single-line input attached; the panel; the engine's state and storage state; a settings form generated
from the metadata (keyboard layout from `hangul-keyboard`'s choices, Hanja keys, initial input mode,
auto-reorder, preedit mode, lookup-table orientation) whose changes apply live and persist across
reloads and tabs; a log pane fed by the facade's `logger`; a "restart engine" control calling a debug
API that terminates the Worker (exercising crash handling without a test engine); and a short how-to
(Shift+Space or the Hangul key toggles Hangul input; F9 converts to Hanja; digits, clicks or arrows pick
a candidate). `nix run .#demo` keeps M1.4a's behaviour (Vite dev server with hot reload over the
checkout); `packages.demo` is the production build the Playwright suites serve.

- [ ] **Step 1:** Build the page and its settings form; keep it one small TypeScript module plus CSS.
- [ ] **Step 2:** run `nix run .#demo` and go through the how-to by hand in Chromium and Firefox; record what you saw in the task report.
- [ ] **Step 3:** `checks.demo` (from M1.4a) still passes against the new page.
- [ ] **Step 4: Commit** `feat(demo): the full demo with the panel and persistent settings`.

### Task 8: Playwright suites, the keystroke bench, WebKit and the bundle scan

**Files:** `tests/playwright/{playwright.config.ts,demo.spec.ts,settings.spec.ts,keystroke.bench.ts,tsconfig.json}`, `modules/playwright.nix` (`packages.playwright-integration`, `apps.keystroke-bench`), `modules/testing/default.nix` (WebKit), `tools/bundle-scan/{scan.ts,scan.test.ts}` and `checks.bundle-scan`, CI generation if the WebKit fallback is needed.

- [ ] **Step 1: Enable WebKit** in `ibusWeb.testing.playwright.browsers` (try `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu-24.04` if nixpkgs' note applies) and confirm a trivial page loads in the sandbox; otherwise configure the CI fallback and record it.
- [ ] **Step 2: Write the suites** against `packages.demo` served by the same Vite configuration in preview mode with COOP/COEP, using `page.keyboard` (trusted events):
  - typing: Shift+Space, then g k s r m f, Space → `한글 ` in the textarea; no stray Latin letters (real `preventDefault`); `input` events only for commits;
  - preedit: visible in the overlay at the caret mid-composition, absent from `value`;
  - undo: Ctrl+Z (Meta+Z on WebKit) removes the last commit as one step;
  - blur mid-composition commits the syllable;
  - Hanja: 한, F9 → the panel shows candidates; clicking one on page 2 (after PageDown) commits that candidate; digits pick on the current page;
  - settings: switching `hangul-keyboard` to 3-set changes composition at once; after a reload it persists; a second tab receives the change live;
  - password input: Latin letters only;
  - restart control: typing works again after the engine restarts.
    Run every spec in Chromium, Firefox and WebKit (or Chromium and Firefox with the WebKit fallback).
- [ ] **Step 3: The keystroke bench** (`nix run .#keystroke-bench`): drives 500 keystrokes through the demo in each browser and prints keydown-to-applied p50/p99 (measured in the page with `performance.now()` around the router's handling), with the machine and browser versions. No timing assertion in `packages.playwright-integration` beyond one-sided generous bounds.
- [ ] **Step 4: The bundle scan:** `checks.bundle-scan` bundles each published page entry (`ibus-web`, `ibus-web/effect`, `ibus-web/panel`, `ibus-web/worker`, `@ibus-web/core`, `@ibus-web/panel`, `@ibus-web/protocol`) and the demo's production build, and fails on Worker, runtime or Emscripten code: WebAssembly magic bytes, Emscripten glue markers, `_ibusweb_` exports, worker-host module paths. Its test feeds it a bundle that inlines the host script and expects failure.
- [ ] **Step 5:** Run `packages.playwright-integration` explicitly and register it in `ibusWeb.testing.extendedChecks` for CI; run the default `nix flake check` at this milestone and record the keystroke bench's figures for the docs.
- [ ] **Step 6: Commit** `test: drive the demo with Playwright in three browsers and scan page bundles`.

### Task 9: Docs and spec

- [ ] **Step 1:** `docs/core.md` (settings persister, adapter overlay and undo), `docs/panel.md` (new), `docs/ibus-web.md` (new: installing, serving with COOP/COEP, the Worker URL, serving `.tar.br` as opaque bytes, licences page), `docs/testing.md` (Playwright, WebKit outcome, keystroke bench, bundle scan), `docs/protocol.md` (lazy lookup tables, `SettingsMetadata`), `docs/engines.md` (`settings.json`), `docs/known-gaps.md` (remove settings persistence and lazy decoding; add the `setRangeText` fallback's undo gap and anything the suites revealed).
- [ ] **Step 2: Spec:** §7.1.4 (metadata from `settings.json`; default values deleted; broadcast payload; last write wins), §7.2.2 (commits through `execCommand` with the fallback; overlay and mirror), §7.3 (panel behaviour), §7.4 (the facade's API and subpaths), §6.3 (lazy lookup decoding), §9.4 (bundle scan as built), §11.5 and §11.7 (suites, WebKit, keystroke figures), §12 (M1.4b done; M1 done, with its questions answered).
- [ ] **Step 3:** `nix flake check`.
- [ ] **Step 4: Commit** `docs: describe the panel, settings, facade and demo`.
