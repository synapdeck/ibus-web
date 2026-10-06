# M1.4a: the page's keystroke path — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new package, `@ibus-web/core`, types Korean through the real Worker host and ibus-hangul in a
browser `<textarea>`: key translation from `KeyboardEvent` to IBus key events, input contexts and focus,
the synchronous keystroke path with its 40 ms spin, the replay queue, crash, hang and restart handling,
and the client duties native IBus clients perform (committing a COMMIT-mode preedit on blur and reset,
surrounding text, content type). A minimal demo, started with `nix run .#demo`, shows it working. M1.4b
adds the overlay preedit and undo-correct adapter, the Hanja panel, the IndexedDB settings persister,
the `ibus-web` facade, the full demo and the Playwright suites.

**Architecture:** `@ibus-web/core` has three layers. `src/keys/` translates events with tables generated
at build time from xorgproto's `keysymdef.h` and Chromium's `dom_code_data.inc`. `src/connection/` drives
one host Worker over the shared-memory transport with `@ibus-web/protocol`'s `RingReader`: synchronous
requests that spin, asynchronous ones that wait for the doorbell, the `reqMode` abandon rule, crash and
hang detection. `src/router/` owns input contexts, the keystroke path (plain synchronous TypeScript
reading a snapshot, spec §7.4) and the replay queue, and applies each reply's records to a
`SurfaceAdapter` in one `batch()`. Effect services and layers (connection pool, engine registry, settings
source, configuration, restart `Schedule`) wrap the synchronous core; nothing on the key path runs a
fiber. A deliberately small textarea adapter and a demo page exercise it end to end.

**Tech Stack:** TypeScript 7, Effect 4.0.0, `@ibus-web/protocol`, `@ibus-web/worker-host` (shared entry and
its Worker scripts), Vitest 5 (Node for the fake-Worker suite; browser mode with Playwright's Chromium and
Firefox for the real host), Vite 8 for the demo, Nix (`files` writer, `pkgs.xorgproto`, `fetchurl`).

## Global constraints

- nixpkgs: whatever `flake.lock` pins; versions from Nix evaluation or the pnpm catalog. New npm dependencies go through the catalog in `modules/typescript/default.nix` (Vite becomes a catalog entry here) and `pnpm-workspace.yaml` is regenerated with `nix run .#write-files`; update `pnpmDeps.hash` when the lock changes.
- **The native synchronous keystroke path is plain synchronous TypeScript** (spec §7.4): from `keydown` to `consumed`/`passthrough`, no promises, fibers or Effect calls. It reads a snapshot that services keep current and hands records and log lines to them through a synchronous enqueue. Task 6b adds a separate, fully asynchronous interface for editor adapters; synchronous and asynchronous surfaces must coexist on the same page, including sharing an engine.
- **License boundary (spec §9.2):** no Worker, runtime or engine code, Emscripten glue included, enters any page bundle; Workers load by URL. `@ibus-web/core` is `MIT OR Apache-2.0`; generated key tables carry their sources' notices (`MIT-open-group` and the Digital HPND-style notice for `keysymdef.h`, `BSD-3-Clause` for `dom_code_data.inc`), and the notices ship in the package (spec §9.3). The router never special-cases an engine's internals.
- `effect` is a peer dependency of every package. Effect 4 conventions: `exactOptionalPropertyTypes` repo-wide; property tests with Effect's `Arbitrary` and fixed seeds; no `SchemaJITCompiler`. Verify APIs against `node_modules/.pnpm/effect@4.0.0/node_modules/effect/dist/*.d.ts`.
- Browser floor: Baseline Widely available (Chrome 123, Firefox 126, Safari 17.4; `legacyPackages.emscriptenMinimumVersions`). Pages must be cross-origin isolated (COOP `same-origin`, COEP `require-corp`).
- **Structured tests:** Vitest; `@effect/vitest` for Effect code. Timing assertions are one-sided only; tests that need ordering get it from instruments or fake clocks, never sleeps.
- TypeScript first (scripts are TypeScript; no inline scripts in Nix); standard formats through maintained libraries (the two key-table sources are C sources whose line formats are documented by their own annotations; their generators are this package's code).
- Comments explain why, not what; never refer to other files, this plan or its history. Docs describe the system as it is.
- Each task passes the focused tests and Nix checks covering its changes; do not rerun the whole integration matrix for unrelated edits. `nix flake check` is the default deterministic gate. Extended browser/storage/stress matrices have explicit commands and CI coverage, and run locally when the affected integration changes or at milestone validation. Task 5a establishes these tiers. Stage named paths only; commit with `nix develop -c git commit -- <paths>`; conventional messages, no attribution lines. The user edits concurrently: never revert changes you didn't make.

## Decisions fixed here

**Keys (spec §7.1.1), with what native IBus clients send:**

- `keycode` is the evdev code of `event.code` (Chromium's `dom_code_data.inc` evdev column). IBus clients send X keycode − 8, which is evdev.
- Engines declare a `keyboard.layout`. **`us`**: the keyval is the US QWERTY keysym for `event.code`, from a bundled table, with Shift and CapsLock applied the way IBus's keymap does (letters: plain lower, Shift upper, Lock upper, Shift+Lock lower; other keys: Shift selects the second level; NumLock selects the keypad's second level), ignoring `event.key`. ibus-hangul needs this: it recomputes keyvals from keycodes with a `us` keymap, which our runtime's `IBusKeymap` reduces to the identity, so the page must already send them. **`default`**: the keyval comes from `event.key` (spec §7.1.1's rules). Named keys in both: a table from UI Events key values to keysyms, including `HangulMode`/`Lang1` → `Hangul` (0xff31) and `HanjaMode`/`Lang2` → `Hangul_Hanja` (0xff34).
- `state`: Shift → `SHIFT_MASK`, CapsLock → `LOCK_MASK`, Control → `CONTROL_MASK`, Alt → `MOD1_MASK`, NumLock → `MOD2_MASK`, Meta → `SUPER_MASK | META_MASK` (and `MOD4_MASK`), AltGraph → `MOD5_MASK` clearing Control and Alt; releases add `RELEASE_MASK` and travel the same synchronous path. Events with `isComposing`, `key === "Dead"`, and all keys while no engine is enabled are never intercepted.
- Engines declare `keyboard.passThrough`: keysym names the router passes straight to the page without asking the engine.

**Manifest:** `EngineManifest` gains `keyboard: { layout: "us" | "default"; passThrough: string[] }` (required). Hangul declares `{ layout = "us"; passThrough = [ ]; }`.

**Capabilities.** The page is both the IBus client and the panel, so the router sets
`PREEDIT_TEXT | AUXILIARY_TEXT | LOOKUP_TABLE | FOCUS | PROPERTY`, plus `SURROUNDING_TEXT` when the
adapter supplies surrounding text. It never sets `SYNC_PROCESS_KEY_V2`: replies already order output
before the reply, and a declined key is applied by the browser; with it, ibus-hangul consumes every key
and forwards the unused ones explicitly. The adapter's capabilities only remove bits.

**The client's preedit duty.** The router keeps each input context's last `UpdatePreeditText` (text,
cursor, visible, mode). Before sending `FocusOut` (blur, surface detach, engine switch) and before
`Reset` (caret moved by the user, selection change, programmatic value change, as the adapter reports
them), if the preedit is visible and its mode is `COMMIT`, the router commits its text through the
adapter and clears the preedit, in one batch, as GTK's `ibus_im_context_clear_preedit_text` does; in
`CLEAR` mode it only clears. ibus-hangul relies on this (it discards its composition on focus-out and
reset), and sends `CLEAR` while its Hanja list is open.

**Surrounding text** (spec §7.1.2): sent on `FocusIn`, after each commit, after each key the engine
consumed, and on `RequireSurroundingText`, only when it changed since the last send; a window of ±1000
characters (configurable) around the caret; cursor, anchor and `DeleteSurroundingText`'s offset and count
in Unicode code points, converted to UTF-16 at the adapter boundary.

**Content type.** `type=password` (and `autocomplete="current-password"`/`"new-password"`): the router
never focuses that surface's input context and passes every key through, as GTK does for invisible
entries. Other inputs send `SetContentType` from `type`/`inputmode`/`autocomplete` before `FocusIn`.

**Keys while the engine isn't ready.** Until the engine's Worker is `ready`, `Init` has completed and the
surface's `CreateEngine` has succeeded, keys pass through (spec: "no engine enabled"). While an
asynchronous request (`CreateEngine` for another surface, `SettingChanged`, `DestroyEngine`) is in flight,
a key is consumed and queued in the replay queue like a timed-out one; it is sent when the doorbell
reports the asynchronous request's completion.

**The keystroke path.** `key(event)`: translate; if passed through, return `passthrough`. Otherwise post
`ProcessKeyEvent` `SYNC` and spin on `state` for at most the budget (40 ms, configurable), draining the
ring into a pending batch; finish when `state == REPLY` and the batch holds every record up to
`replyOutSeq`, or on `CRASHED`. On a reply, set `IDLE`, apply the batch in one `adapter.batch()`, then
return `consumed` (reply 1) or `passthrough` (reply 0). On budget exhaustion, compare-exchange `reqMode`
`SYNC` → `ABANDONED`, re-read `state` (a reply that landed is handled at once), else mark the connection
busy, queue the event and return `consumed`. While busy, later keys are queued (up to 64) and return
`consumed`. On the doorbell, the router drains, completes the abandoned request (applying its records;
a declined key is applied with `adapter.replayKey(event)`), then sends queued keys one by one
asynchronously (`ASYNC`, each completed by a doorbell), replaying declined ones. The doorbell word is
stored 0 **before** draining.

**Hangs and crashes** (spec §8). A hang is a request (sync after abandonment, or async) with no reply and
no ring movement for 2 s (configurable; `Init` has a separate 30 s initialization allowance), or a replay queue that would exceed 64: the router terminates the
Worker and treats it as a crash. On a crash (`CRASHED`, the `crashed` host message, a Worker `error`
event, or a hang): the in-flight key passes through (`replayKey`), queued keys are replayed in order,
every input context of that engine has its preedit cleared and panel output hidden, and the restart
`Schedule` runs: immediately, then exponential backoff from 250 ms; after 3 crashes in 60 s the engine is
`failed` and its surfaces fall back to direct input. Before relaunching a Worker whose last `storage`
state wasn't `read-only`, the router waits for the engine's writer lock (`engineWriterLock(name)`) for up
to 10 s. A restarted engine gets `Init` with the current settings and recreates input contexts lazily on
their next focus; composition is lost.

**Runtime constants ship with the runtime.** The runtime's distribution directory gains
`constants.json` (`RuntimeConstants` plus `poolLowWater`) beside `ibus-runtime.js`/`.wasm`; the host reads
it from `new URL("constants.json", runtimeUrl)` during bootstrap. `HostInit` loses `constants` and
`poolLowWater`; a page needs only URLs.

**Settings in M1.4a** are a `SettingsSource` service with `snapshot(schemas): Promise<Record<schemaId, Record<key, GVariantVariant>>>`, `written(record)` and `changes: Stream`; the default is in memory.
M1.4b replaces it with the IndexedDB persister and its BroadcastChannel, keyed through build-time schema
metadata.

**Adapter contract** (spec §7.2), the part M1.4a needs (M1.4b's textarea adapter fills in the overlay and
undo):

```ts
export interface SurfaceAdapter {
  readonly element: HTMLElement;
  capabilities(): { preedit: boolean; auxText: boolean; lookupTable: boolean; surroundingText: boolean };
  contentType(): { purpose: number; hints: number; disabled: boolean };
  surrounding(window: number): { text: string; cursor: number; anchor: number } | undefined; // UTF-16 units
  caretRect(): DOMRect | undefined; // viewport coordinates
  batch(apply: () => void): void; // one host transaction, one undo step
  commit(text: string): void;
  deleteSurrounding(offset: number, count: number): void; // UTF-16 units, relative to the caret
  setPreedit(preedit: Preedit | undefined): void; // never document content
  replayKey(event: KeyboardEvent): void; // apply a key the engine declined
  forwardKey(key: { keyval: number; keycode: number; state: number }): void;
  onReset(listener: () => void): () => void; // caret/selection/value changes not made by the router
}
export interface Preedit {
  text: string;
  cursor: number;
  attributes: readonly PreeditAttribute[];
} // UTF-16 offsets
export type KeyResult = "consumed" | "passthrough";
```

The panel-facing records (lookup table, auxiliary text, properties) are published on a `PanelEvents`
stream that M1.4b's panel consumes; M1.4a's demo prints them.

**The demo** is a private workspace package, `examples/hangul`, run by Vite's dev server with hot reload
and COOP/COEP headers. `nix run .#demo`, from the checkout, installs the workspace's dependencies if they
are missing (`pnpm install --frozen-lockfile`), builds the packages the demo imports, and starts Vite's
dev server over the demo's sources, with the Nix-built runtime, host Worker scripts and Hangul
distribution served by a middleware from store paths the app passes in. Tests (and M1.4b's Playwright
suites) use `packages.demo`, a production build of the same page.

## File map

| Path                                                                                                                                                               | Responsibility                                                                           | Task |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ---- |
| `packages/protocol/src/ibus/flags.ts`, `test/ibus/flags.test.ts`, `test/ibus/flags/constants.c`                                                                    | IBus capability, modifier, purpose and hint values, checked against the vendored headers | 1    |
| `tools/keysyms/{keysymdef.ts,dom-codes.ts,*.test.ts,tsconfig.json}`, `packages/core/src/keys/{keysyms,dom-codes}.generated.ts`, `modules/keys.nix`                 | table generators and generated tables                                                    | 1    |
| `LICENSES/{MIT-open-group,HPND-DEC,BSD-3-Clause}.txt`, `REUSE.toml`, `packages/core/LICENSES/`                                                                     | notices                                                                                  | 1    |
| `packages/core/src/keys/{translate,us,named}.ts`, `test/keys/*`                                                                                                    | key translation                                                                          | 2    |
| `packages/protocol/src/manifest.ts`, `modules/engines/manifest.nix`, `engines/hangul/package.nix`                                                                  | `keyboard` in manifests                                                                  | 2    |
| `runtime/ibus-runtime/package.nix`, `packages/worker-host/src/{shared/messages,worker/host}.ts`, worker-host tests                                                 | runtime constants beside the runtime                                                     | 3    |
| `packages/core/{package.json,tsconfig*.json,tsdown.config.ts,vitest.config.ts,module.nix}`, `src/connection/*`, `test/connection/*`, `test/support/fake-worker.ts` | the connection, fake Worker                                                              | 4    |
| `packages/core/src/router/{keystroke,replay,restart}.ts`, `src/services/*`, `test/router/*`                                                                        | keystroke path, replay, hangs, restarts, services                                        | 5    |
| `packages/core/src/router/{router,contexts,surrounding,preedit}.ts`, `src/adapters/textarea.ts`, `test/router/*`                                                   | input contexts, client duties, minimal adapter                                           | 6    |
| `packages/core/test/browser/*`, `packages/core/module.nix`                                                                                                         | the real host and Hangul in browsers                                                     | 7    |
| `examples/hangul/**`, `modules/demo.nix`                                                                                                                           | the demo                                                                                 | 8    |
| `docs/core.md`, `docs/README.md`, `docs/known-gaps.md`, `docs/worker-host.md`, spec                                                                                | docs                                                                                     | 9    |

---

### Task 1: IBus values and key tables

**Files:** see the file map's Task 1 rows.

**Interfaces (produced):**

- `@ibus-web/protocol`: `IBusCapability` (`PREEDIT_TEXT 1, AUXILIARY_TEXT 2, LOOKUP_TABLE 4, FOCUS 8, PROPERTY 16, SURROUNDING_TEXT 32, OSK 64, SYNC_PROCESS_KEY_V2 128`), `IBusModifier` (`SHIFT 1<<0 … MOD5 1<<7, BUTTON1…5, HANDLED 1<<24, IGNORED 1<<25, SUPER 1<<26, HYPER 1<<27, META 1<<28, RELEASE 1<<30`), `IBusInputPurpose`, `IBusInputHints`: `as const` objects with IBus's names and values.
- `@ibus-web/core/keys` internals: `keysymForCodepoint(cp): number | undefined`, `codepointForKeysym(keysym): number | undefined`, `keysymByName: ReadonlyMap<string, number>`, `evdevForCode(code: string): number | undefined`.

- [ ] **Step 1: Failing tests.**
  - `flags.test.ts`: every value equals the vendored IBus headers' (`runtime/libibus-web/include/ibus-1.0/ibustypes.h`): a native C program, `test/ibus/flags/constants.c`, compiled in Nix against those headers, prints the values as JSON (the pattern `packages/worker-host/test/sides/constants.c` uses), and the test compares; the check passes its path in the environment.
  - `tools/keysyms/keysymdef.test.ts`: on fixture lines covering `/* U+00E9 … */`-style `// U+xxxx` mappings, `//<U+xxxx>` (keysym → character only), `(U+xxxx)` (not used for character → keysym), aliases sharing a value (first name canonical) and lines without a mapping, the generator's maps are exactly right; on the real `keysymdef.h`, `a` → 0x61, `Hangul` → 0xff31, `Hangul_Hanja` → 0xff34, U+3131 → its Korean keysym.
  - `tools/keysyms/dom-codes.test.ts`: fixture `DOM_CODE(…)` rows (including a row without an evdev value) parse; on the real file, `KeyA` → 30, `Lang1` → 122, `Lang2` → 123, `Space` → 57.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.** `flags.ts` by hand from IBus's documented values (the test guards them). Generators in `tools/keysyms/` read `${pkgs.xorgproto}/include/X11/keysymdef.h` and a single `dom_code_data.inc` fetched with `fetchurl` at the Chromium revision nixpkgs' `chromium` is built from (record the revision and hash; the GitHub mirror's raw URL serves the plain file) and print TypeScript modules with the sources' copyright notices in their headers. `modules/keys.nix` runs them and commits `packages/core/src/keys/*.generated.ts` through `files.file`. Add the three licence texts (`reuse download`), annotate the generated files in `REUSE.toml`, and ship the notices in `packages/core` (`LICENSES/` listed in `files`).
- [ ] **Step 4:** `nix run .#write-files`; `nix build -L .#checks.x86_64-linux.{protocol,hk}` plus the new generator tests (`tools` Vitest) and `files:` checks.
- [ ] **Step 5: Commit** `feat: generate key tables and define IBus's client flags`.

### Task 2: Key translation and engine keyboards

**Files:** `packages/core/src/keys/{translate,us,named}.ts`, `test/keys/{translate,us}.test.ts`; `packages/protocol/src/manifest.ts` and its test; `modules/engines/manifest.nix`; `engines/hangul/package.nix`; worker-host test manifests.

**Interfaces (produced):** `translateKey(event: KeyLike, layout: "us" | "default"): { keyval: number; keycode: number; state: number } | undefined` (undefined = never intercept), with `KeyLike = Pick<KeyboardEvent, "type" | "key" | "code" | "isComposing" | "repeat"> & { getModifierState(key: string): boolean }`.

- [ ] **Step 1: Failing tests** (table-driven):
  - `us`: `KeyG` → `g`/30; with Shift → `G`; with CapsLock → `G`; Shift+CapsLock → `g`; `Digit1` Shift → `exclam`; `Numpad1` with and without NumLock; `Space` → `space`/57; `keyup` adds `RELEASE_MASK`; Control/Alt/Meta/AltGraph map to their masks, AltGraph clearing Control and Alt; `event.key` is ignored (`KeyQ` with `key = "a"` still gives `q`).
  - `default`: single code points (Latin-1 directly, a legacy keysym where one exists, else `0x01000000 + cp`), named keys (`Backspace`, `ArrowLeft`, `Shift`, `Enter`, `Escape`, F1–F12).
  - both: `HangulMode`/`Lang1` → 0xff31/122, `HanjaMode`/`Lang2` → 0xff34/123; `isComposing` and `key === "Dead"` → undefined.
  - manifest: `keyboard` required; `layout` one of `us`/`default`; `passThrough` names must be keysym names (checked against `keysymByName` in core's manifest use, not in protocol); the Hangul distribution's manifest carries `{ layout: "us", passThrough: [] }`.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement** the translation; the US table by hand (about fifty keys, each `code → [plain, shifted]` keysym names, letters marked as case-paired), cross-checked in a test against `codepointForKeysym`. Add `keyboard` to the schema, `mkEngineManifest` (a `keyboard` argument) and Hangul; update the worker-host test manifests.
- [ ] **Step 4:** `nix build -L .#checks.x86_64-linux.{protocol,worker-host-node,hangul-host,hk}` and the core package's tests.
- [ ] **Step 5: Commit** `feat(core): translate keyboard events to IBus key events`.

### Task 3: Runtime constants beside the runtime

**Files:** `runtime/ibus-runtime/package.nix` (install `constants.json`), `runtime/ibus-runtime/checks.nix`, `packages/worker-host/src/shared/messages.ts` (`HostInit` without `constants`/`poolLowWater`), `src/worker/host.ts` (fetch and decode them), worker-host test harnesses and `module.nix`.

- [ ] **Step 1: Failing tests:** a host started without `constants`/`poolLowWater` in `HostInit` starts (Node and browser suites); a runtime directory whose `constants.json` is missing or malformed fails the start with a message naming it; the built runtime's `constants.json` equals what the worker-host test derivation computed (runtime ABI, protocol, errno values, pump error, wait timeout, read-only code, memory bounds, `poolLowWater`).
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement**; the constants derivation moves from the worker-host tests into `ibus-runtime`'s package (the C program and the jq step), and the tests use the runtime's file.
- [ ] **Step 4:** `nix build -L .#checks.x86_64-linux.{worker-host-node,worker-host-browser,hangul-host,ibus-runtime-load,hk}`.
- [ ] **Step 5: Commit** `feat: ship the runtime's constants with the runtime`.

### Task 4: `@ibus-web/core` and the connection

**Files:** the package scaffold (as `packages/protocol`'s: `package.json` with `effect` peer, `@ibus-web/protocol` and `@ibus-web/worker-host` dependencies, tsconfigs split `src/shared` (no globals) / `src/page` (DOM) / `test/node` / `test/browser`, `tsdown.config.ts` with `effect` external and the Worker scripts never bundled, `vitest.config.ts`, `module.nix` with `checks.core`), `src/connection/{connection,requests,crash}.ts`, `test/support/fake-worker.ts`, `test/connection/*.test.ts`.

**Interfaces (produced):**

```ts
export interface ConnectionOptions {
  hostUrl: URL;
  runtimeUrl: URL;
  manifestUrl: URL;
  storage: "browser" | "none";
  layout?: TransportLayout;
  budgetMs: number;
  hangMs: number;
  worker?: (url: URL) => Worker; /* tests */
}
export class Connection {
  // one host Worker
  static start(options: ConnectionOptions): Promise<Connection>; // resolves on "ready", rejects on "error"
  requestSync(request: Request, ic: number): SyncOutcome; // spins up to budgetMs; never awaits
  requestAsync(request: Request, ic: number): Promise<Reply>; // ASYNC, resolved on the doorbell
  readonly records: { take(): DecodedRecord[] }; // drained, seq-checked
  onDoorbell(listener: () => void): () => void;
  onCrash(listener: (crash: CrashInfo) => void): () => void;
  terminate(): void;
}
export type SyncOutcome =
  | { _tag: "reply"; ret: number; records: DecodedRecord[] }
  | { _tag: "pending" }
  | { _tag: "crashed"; crash: CrashInfo };
export interface CrashInfo {
  reason: "trap" | "fault" | "relay" | "load" | "host" | "hang" | "worker";
  message: string;
  storage?: "read-only" | "ephemeral" | "closed";
}
```

The fake Worker (`test/support/fake-worker.ts`) implements the host's side in-process over a real
`SharedArrayBuffer` with protocol's `RingWriter`: it reads requests from the slot, and a script decides
each reply's records, return value, timing (immediate, after N ms of a fake clock, never), ring
back-pressure, fragments, doorbells and crashes, following PROTOCOL.md's transport rules exactly.

- [ ] **Step 1: Failing tests** against the fake Worker: a sync request completes within the budget and returns its records up to `replyOutSeq` (records past it stay for the next take); a reply whose records arrive after `REPLY` is still completed only once they're drained; budget exhaustion abandons (`reqMode` becomes `ABANDONED`) and returns `pending`; the reply that lands between the timeout and the compare-exchange is returned as a reply; an async request resolves on the doorbell; the doorbell word is cleared before draining (a fake that suppresses a second doorbell still has its records drained); fragments reassemble; `Crashed` record → crash with its reason; `CRASHED` without a record → crash; the `crashed` host message and a Worker `error` event → crash; seq gaps or a non-zero host record ic → `ProtocolError` logged and the record dropped (production), thrown (development flag).
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.** Start: compile the runtime once (`WebAssembly.compileStreaming`, cached per URL), `createControl(layout)`, `new Worker(hostUrl, { type: "module" })`, post one `HostInit`, wait for `ready`/`error`. No Effect inside `requestSync`.
- [ ] **Step 4:** `nix build -L .#checks.x86_64-linux.{core,hk}`.
- [ ] **Step 5: Commit** `feat(core): drive a Worker host over the shared-memory transport`.

### Task 5: The keystroke path, the replay queue, hangs and restarts

**Files:** `src/router/{keystroke,replay,restart}.ts`, `src/services/{config,engines,settings,logging}.ts`, `test/router/{keystroke,replay,restart,hang}.test.ts`.

**Interfaces (produced):** `KeySink { key(event: KeyboardEvent): KeyResult }`; `CoreConfig` (`budgetMs` 40, `hangMs` 2000, `replayLimit` 64, `surroundingWindow` 1000, `restart: Schedule`, ring and slot sizes) as a `Context.Service` with a default layer; `EngineRegistry` (`select(name)`, `state(name)`: `starting | ready | busy | restarting | failed`); `SettingsSource` (in-memory default); a `Logger` mapping `Log` records' GLib levels to Effect levels (Error, Critical → Error; Warning → Warning; Message, Info → Info; Debug → Debug), annotated with engine, input context and domain.

- [ ] **Step 1: Failing tests** (fake Worker, fake clock, fake adapter recording calls):
  - a consumed key's records are applied in one `batch()` in order, and `key` returns `consumed`; a declined key returns `passthrough`;
  - a slow reply: `key` returns `consumed` after the budget, the event is queued, later keys queue and return `consumed`; on the doorbell the abandoned request completes, declined keys are replayed with `replayKey` in order, queued keys are sent `ASYNC` one at a time in order;
  - the 65th queued key → hang → crash path; no reply and no ring movement for 2 s → hang; ring movement resets the hang clock;
  - a crash with an in-flight key and queued keys: the in-flight and queued events are replayed in order, preedits cleared, panel events hidden, the restart schedule runs (immediate, then backoff), and after 3 crashes in 60 s the engine is `failed` and keys pass through;
  - a restart waits for the writer lock (fake lock that releases after 1 s), unless the last storage state was `read-only`; gives up after 10 s with the engine `failed`;
  - after a restart `Init` carries the current settings and input contexts are recreated on next focus.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement**; the keystroke path reads a snapshot object the services update; the services' fibers drain a synchronous queue of records and log lines.
- [ ] **Step 4:** `nix build -L .#checks.x86_64-linux.{core,hk}`.
- [ ] **Step 5: Commit** `feat(core): serve keys synchronously with a replay queue and restart crashed engines`.

### Task 5a: Separate default checks from extended integration

**User correction:** Slow and scheduling-sensitive browser/storage matrices are unsuitable for every `nix flake check` and every implementation task. Preserve their coverage through explicit integration commands and CI. Serialization alone does not solve test placement or broad cache invalidation.

**Files:** `modules/{testing/default,typescript/default,typescript/options,flake/ci}.nix`, `packages/worker-host/{module.nix,vitest.unit.config.ts,test/browser/smoke.test.ts}`, generated `.github/workflows/ci.yml`, `engines/hangul/checks/host/default.nix` as needed for narrowed workspace inputs, and `docs/{testing,worker-host}.md`.

**Interfaces (produced):**

- `ibusWeb.typescript.workspaceFor(packageDirs)` builds the selected packages and their workspace dependency closure with the existing build machinery; `workspace` remains the complete workspace. Source-only edits to an excluded package must not invalidate the selected workspace. Use this for WorkerHost checks rather than the whole-workspace output.
- `checks.worker-host-node` runs deterministic Node unit tests; `checks.worker-host-browser` runs a small real Worker/protocol smoke set in Chromium and Firefox. Keep tight heartbeat timing, installation/upgrade contention, and stress scenarios out of those default sets.
- Preserve the complete current matrices as explicit `packages.worker-host-node-integration` and `packages.worker-host-browser-integration`. `packages.integration-checks` aggregates extended checks registered through `ibusWeb.testing.extendedChecks`; CI runs them separately from the default gate. Later Playwright end-to-end matrices use this extended tier. Keep the small real Hangul host conformance gate unless measurements establish it belongs in the extended tier.

- [ ] **Step 1: Inspect and record** existing suite groups, their dependencies, observed timings, and exact cases selected for default smoke. No existing test may silently disappear; map every moved group to an explicit target.
- [ ] **Step 2: Add failing verification** for default/extended separation, absence of extended matrix derivations from the default dependency graph, and selected-workspace source invalidation. A source-only core edit leaves WorkerHost check derivations unchanged; a WorkerHost source edit changes them. Restore all probe edits before validation. Default smoke asserts actual startup, request/reply and ordered protocol output with a real Worker, rather than only successful loading.
- [ ] **Step 3: Implement** the selected-workspace builder, suite placement, explicit integration targets and generated CI jobs using repository Nix/module conventions. Keep existing test assertions intact. Do not weaken timing limits, add automatic retries or serialize every runner to make default checks pass. Report any observed flaky extended case with evidence.
- [ ] **Step 4: Verify** affected unit/default-smoke checks, generated files/hk and the new default `nix flake check`. Run the explicit extended targets once to establish preserved coverage after changing their configuration/inputs. Record elapsed time and exact results separately for default and extended gates; cold toolchain compilation and test execution are distinct costs.
- [ ] **Step 5: Commit** `test: separate default checks from extended integration suites`.

Subsequent tasks run covering checks rather than the full matrix. Documentation must replace the current claim that every test is a flake check and list the explicit integration command and CI ownership.

### Task 5b: Centralize and clean packaged upstream notices

**User correction:** License texts belong in the central root store and are copied into package artifacts during assembly. Do not retain a duplicate `packages/core/LICENSES/` directory in the checkout. Extracted upstream notices must be plain text, with source-comment delimiters removed and their copyright, permission and disclaimer wording preserved.

**Files:** `LICENSES/`, `NOTICES/`, `REUSE.toml`, `modules/keys.nix`, `modules/typescript/default.nix` as needed for hermetic packaging inputs, `packages/core/package.json`, `tools/keysyms/{notices.ts,notices.test.ts,us.ts,us.test.ts}`, and removal of tracked `packages/core/LICENSES/` copies. Reuse the existing root project-license prepack/postpack convention. Keep changes specific to packaging the core's generated key tables.

**Interfaces (produced):** One canonical central source for each shipped license/notice: SPDX texts and exact XKB COPYING in `LICENSES/`, source-specific X11/Chromium notices in `NOTICES/` (REUSE treats every nested `LICENSES/` file as a license definition). The assembled core package includes its project licenses, relevant SPDX license texts, exact X11/Chromium notices and pinned xkeyboard-config COPYING. Package-local notice copies are packaging outputs, not persistent source assets. Any source-notice extraction helper accepts pinned upstream content and returns clean plain text; generated headers and REUSE annotations retain accurate attribution.

- [ ] **Step 1: Write failing tests** proving the X11 notice has no C comment wrapper, Chromium's notice has no `//` prefixes, and all substantive notice wording survives extraction. Keep xkeyboard-config COPYING byte-identical to its pinned input. Verify the actual packed core artifact contains the required notices and that pack cleanup leaves no package-local license copies in the checkout.
- [ ] **Step 2: Run focused tests and record expected failures.**
- [ ] **Step 3: Implement** central notice storage/generation and package-assembly copying. Standard SPDX template texts do not replace source-specific copyright notices. Remove duplicated tracked package files and their duplicate-generation/asset declarations. Supply only the canonical inputs needed by hermetic Nix builds/tests; do not bypass package-relative asset validation or introduce a general packaging framework.
- [ ] **Step 4: Verify** focused extraction tests, an actual core package pack and content inspection, relevant generated-file checks and REUSE/hk after self-review/type/format corrections. Document source provenance and any normalization precisely; do not rerun unrelated extended integration matrices.
- [ ] **Step 5: Commit** `fix(core): assemble clean notices from the central license store`.

### Task 6: Input contexts and the client's duties

**Files:** `src/router/{router,contexts,surrounding,preedit}.ts`, `src/adapters/textarea.ts`, `test/router/{contexts,preedit,surrounding,content-type,switching}.test.ts`.

**Interfaces (produced):** `Router` with `attach(adapter: SurfaceAdapter): () => void`, `select(engine: string)`, `override(adapter, engine | undefined)`, `hotkeys: HotkeyRegistry` (empty by default), `panel: Stream<PanelEvent>`; `textareaAdapter(element: HTMLTextAreaElement | HTMLInputElement, options?: { onPreedit?: (p: Preedit | undefined) => void }): SurfaceAdapter` — commits with `setRangeText` and an `input` event, deletes surrounding text likewise, replays keys by inserting their character or performing the editing action (Backspace, Delete, Enter in a textarea, arrows), reports preedit through `onPreedit` (no overlay; M1.4b), and reports resets on `selectionchange`/`pointerdown` moving the caret and on `value` changes it didn't make.

- [ ] **Step 1: Failing tests** (fake Worker, a DOM from Vitest's browser mode or `happy-dom` if the package already allows it — prefer browser mode):
  - first focus sends `CreateEngine`, `SetCapabilities` (the Decisions' bits, never `SYNC_PROCESS_KEY_V2`, `SURROUNDING_TEXT` only with an adapter that supplies it), `SetContentType`, `FocusIn`, `SetSurroundingText`; blur sends `FocusOut`; a second surface gets its own input context;
  - COMMIT-mode visible preedit on blur → one batch committing its text and clearing the preedit, then `FocusOut`; `CLEAR` mode → cleared without commit; same on a reset reported by the adapter, before `Reset`;
  - surrounding text: sent on focus, after commits, after consumed keys and on `RequireSurroundingText`, not resent when unchanged; ±1000-character window; code points vs UTF-16 with astral characters on both sides; `DeleteSurroundingText(-1, 1)` before an astral character deletes two UTF-16 units;
  - `type=password` → no input context, keys pass through;
  - `SetCursorLocation` after a batch that moved the caret rectangle;
  - engine switch: `Disable` + `FocusOut` to the old, `Enable` + `FocusIn` to the new; detaching a surface sends `DestroyEngine` and drops its later output;
  - `ForwardKeyEvent` → `adapter.forwardKey`; `DeleteSurroundingText` before `CommitText` applied in that order.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `nix build -L .#checks.x86_64-linux.{core,hk}`.
- [ ] **Step 5: Commit** `feat(core): route input contexts and perform the client's preedit and surrounding-text duties`.

### Task 6b: Fully asynchronous input alongside native synchronous surfaces

**User requirement:** The primary Markdown editor uses CodeMirror. It needs a fully asynchronous interface while normal `<input>` and `<textarea>` surfaces retain synchronous native passthrough, including on the same page. Input policy belongs to each surface, not the page or engine.

**Files:** Modify `packages/core/src/router/{router,contexts,keystroke,replay}.ts`, `packages/core/src/services/engines.ts` and `packages/core/src/page/index.ts`; add `packages/core/test/router/async.test.ts` and mixed-surface browser cases under `packages/core/test/browser/`. Modify the core browser check wiring as needed.

**Interfaces (produced):** Extend `Router.attach(adapter, options?: { keyMode?: "sync" | "async" | "manual" }): () => void`, defaulting to `sync`. `async` installs asynchronous key handling; `manual` preserves context lifecycle without installing keyboard interception, for editor-owned capture. Add `Router.keyAsync(adapter, event): Promise<AsyncKeyResult>`, where `AsyncKeyResult` is `"consumed" | "replayed" | "passthrough" | "cancelled"`. `consumed` means reply records have been applied; `replayed` means the adapter has already applied the declined key exactly once; `passthrough` means the event was excluded from interception and was not replayed; `cancelled` means the owning context was detached/disposed before completion. Callers must not replay a `replayed` result. Editor-owned capture must preserve native handling for excluded composing/dead events. M1.4b Task 6 exposes this custom-adapter/manual-input path alongside native `attach(element)`.

- [ ] **Step 1: Write failing tests** with deterministic fake Worker instruments and deferred replies:
  - asynchronous dispatch never calls `requestSync` or spins, even with an immediately available reply;
  - a synchronous native input and asynchronous editor adapter share one Router and engine, retain distinct input contexts, and receive only their own output;
  - consumed output applies before promise settlement; declined-key fallback applies once through the adapter before the next dependent key is dispatched;
  - queued keys preserve order across lifecycle/settings requests and mixed surface modes; changing one surface's mode does not change another's;
  - focus movement while a reply is pending does not redirect that reply; detached/replaced contexts ignore late output and settle their awaiters;
  - crashes and queue overflow settle awaiters and perform fallback exactly once; disposal settles outstanding promises without editing disposed surfaces;
  - existing keydown/keyup translation, pass-through declarations, composing/dead-key bypass, password exclusions and readiness gating remain intact;
  - `manual` attachments do not also intercept the editor's keyboard events; browser tests cover concurrent native and editor-style adapter lifecycle.
- [ ] **Step 2: Run the focused tests and record their expected failures.**
- [ ] **Step 3: Implement** the asynchronous entry point through the existing engine FIFO, ASYNC transport, output ring, watchdog and restart machinery. Keep fallback ownership explicit and generation/context checks intact. Do not introduce a second engine dispatcher, a CodeMirror dependency or a Markdown editor implementation.
- [ ] **Step 4: Verify** focused tests and covering core/browser/Hangul checks after self-review/type/format corrections. Record the exact commands and results. Concrete CodeMirror integration is not established by an editor-style test adapter.
- [ ] **Step 5: Commit** `feat(core): support asynchronous editor input alongside native surfaces`.

Task 9 documents both modes, per-surface configuration and fallback/cancellation ownership. This user amendment extends the older spec's synchronous-only integration contract.

### Task 7: The real host and Hangul in browsers

**Files:** `packages/core/test/browser/{hangul,crash}.test.ts`, `packages/core/module.nix` (`checks.core-browser`: Vitest browser mode, Chromium and Firefox, serving the runtime, the host's Worker scripts and the Hangul distribution with COOP/COEP through `@ibus-web/test-programs/vitest`'s `serveDirs`/`servePlugin`).

- [ ] **Step 1: Write the cases**, each typing with synthetic `KeyboardEvent`s dispatched on a real `<textarea>` with `textareaAdapter`:
  - Hangul key, then ㅎ ㅏ ㄴ ㄱ ㅡ ㄹ, space → the textarea's value is `한글 ` (CapsLock state off; the US layout's keysyms), and `input` events fired for commits only;
  - blur mid-composition → the composed syllable is committed (the client's COMMIT duty);
  - a password input → typing inserts Latin letters untouched by the engine;
  - Hanja: 한, F9, a candidate chosen with a digit → the candidate replaces the syllable (DeleteSurroundingText then CommitText when surrounding text is on);
  - crash: the thrower test engine (or the host's trap side) → the in-flight key is applied by the browser, the engine restarts, typing works again.
- [ ] **Step 2: Run** `nix build -L .#checks.x86_64-linux.core-browser`; fix core, not expectations.
- [ ] **Step 3: Commit** `test(core): type Hangul through the real host in Chromium and Firefox`.

### Task 8: The demo

User performance amendment (2026-10-05): the measured eight-second persistent initialization is unusable. Measure the IndexedDB read/transaction pattern and cold/warm initialization against ephemeral storage, then repair the smallest proven source of repeated I/O overhead while preserving sealed-data integrity, writable-file semantics, thread safety and bounded memory. Demonstrate actual persistent Hangul startup and composition after the repair, report timings and evidence limits, and add focused regression coverage. A larger Init watchdog alone does not satisfy this task.

Persistent initialization amendment (2026-10-05): real Hangul IndexedDB-backed module/data initialization measured 7.8 s without ring output. Add `CoreConfig.initHangMs` (default 30,000 ms), optional `ConnectionOptions.initHangMs` with that default, and registry forwarding. Use this inactivity budget only for protocol `Init`; ordinary requests retain the 2,000 ms `hangMs` budget. Both must be finite and positive. Cover Init grace and eventual hang plus unchanged ordinary-request timeout with deterministic clocks, and verify real persistent Hangul startup/composition in the example. Document the separate initialization allowance in Task 9; no global watchdog relaxation.

**Files:** `examples/hangul/{package.json,index.html,src/main.ts,src/style.css,vite.config.ts,tsconfig.json}`, `modules/demo.nix` (`apps.demo`, `packages.demo`, `checks.demo`), catalog entry for `vite`, workspace discovery in `modules/typescript/default.nix` and regenerated `pnpm-workspace.yaml`.

The page: a textarea attached to the router with Hangul selected, an on/off switch (the Hangul key also
toggles Hangul/Latin inside the engine), the current preedit shown on a line under the textarea, the
panel events (lookup table candidates with their labels, auxiliary text, the `InputMode` property's
symbol) printed in a side list, the engine state (`starting`, `ready`, `restarting`, `failed`) and the
storage state, a "crash the engine" button available in the demo build only when a test engine is
present (omit it otherwise), and a short how-to (the Hangul key or Shift+Space toggles Hangul input, F9 converts to Hanja).

- [ ] **Step 1:** Register `examples/*` in the Nix-owned workspace globs and regenerate `pnpm-workspace.yaml`; include the example in workspace discovery and build inputs. Vite config: COOP/COEP headers on every response; a middleware serving the runtime, host Worker scripts and Hangul distribution from paths given in the environment (`IBUS_WEB_DEMO_RUNTIME`, `IBUS_WEB_DEMO_HOST`, `IBUS_WEB_DEMO_HANGUL`), as plain bytes (no `Content-Encoding` on `.tar.br`).
- [ ] **Step 2:** `apps.demo` (`nix run .#demo`): a `writeShellApplication` that requires being run inside the checkout (finds the flake root), sets the three variables to Nix store paths, runs `pnpm install --frozen-lockfile` when `node_modules` is missing, builds the workspace packages the demo depends on (`pnpm --filter demo... --filter '!demo' run build`), and runs `pnpm --dir examples/hangul exec vite` (dev server, hot reload) on `127.0.0.1:5173` by default. Forward Vite arguments so `nix run .#demo -- --port 5174` selects a custom port. The dev shell exports the same variables so `pnpm --dir examples/hangul dev` works there too. `packages.demo` is `vite build` of the page with the three directories copied in, for tests.
- [ ] **Step 3:** `checks.demo`: builds the demo, starts its server in the build, loads the page in Playwright's Chromium (the `ibusWeb.testing.playwright` environment), types 한 with synthetic events through the page and asserts the textarea's value — a smoke test, not the Playwright suite of M1.4b.
- [ ] **Step 4:** run `nix run .#demo` yourself and type in it; record in the task report what you saw.
- [ ] **Step 5: Commit** `feat(demo): a demo page for typing Korean through ibus-web`.

### Task 9: Docs and spec

- [ ] **Step 1:** `docs/core.md` (new): the package's layers, key translation and layouts, the keystroke path, the replay queue, crashes and restarts, the client's preedit and surrounding-text duties, capabilities, the adapter contract, settings source, how to run the demo. `docs/README.md` links it. `docs/worker-host.md`: `HostInit` without constants; `constants.json` beside the runtime. `docs/known-gaps.md`: remove the page router, client preedit policy, published constants and writer-lock-wait items; keep settings persistence and lazy lookup decoding for M1.4b; note that `IBusEngineSimple`'s missing compose leaves Latin mode to the browser.
- [ ] **Step 2: Spec:** §5.4.4 (`keyboard` in manifests), §7.1.1 (`us` layout from `event.code` with IBus's Shift/Lock rule, named Hangul/Hanja keys), §7.1.2 (capabilities without `SYNC_PROCESS_KEY_V2`; the COMMIT-mode duty on blur and reset; surrounding-text triggers; password inputs never focused; keys while the engine isn't ready), §6.2.6 (keys during asynchronous requests queue), §8 (hang definition), §12 (M1.4 split into M1.4a and M1.4b; M1.4a done).
- [ ] **Step 3:** `nix flake check`.
- [ ] **Step 4: Commit** `docs: describe the page's keystroke path and the demo`.
