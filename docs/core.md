# Page core

`@ibus-web/core` is the page-side client: key translation, scoped engine lifecycle,
input contexts, ordered output and adapters. It imports only the host's shared
transport definitions; Worker, runtime, Emscripten and engine implementations load
by URL and stay outside the page bundle. The package is MIT OR Apache-2.0, with the
generated tables' source notices included in its distribution.

## Layers and page lifetime

The page entry exports `Router`, `EngineRegistry`, `CoreConfig`, `SettingsSource`,
`Logger`, `PanelEvents`, `Connection`, `textareaAdapter` and their public types.
`@ibus-web/core/keys` exports translation and table helpers without page services.
`effect` is a peer dependency; the host application provides the shared copy.

Provide `Router.Default` with `EngineRegistry.layer({ hostUrl, runtimeUrl, engines })`,
then provide `CoreConfig.Default`, `SettingsSource.Default`, `Logger.Default` and
`PanelEvents.Default`. Registry keys in `engines` map to manifest URLs; they need
not equal the manifest's name or instance engine name. `runtimeUrl` names
`ibus-runtime.js`, with `.wasm` and `constants.json` beside it. Serve every response
with COOP `same-origin` and COEP `require-corp` for cross-origin isolation.

Acquire and use the services inside a live Effect scope. Closing the scope removes
listeners and terminates Workers; do not return a router from an already-closed
`Effect.scoped` program. The [Hangul example](../examples/hangul/src/main.ts) provides
the complete layer wiring and aborts its long-lived program on pagehide or HMR disposal.

`router.select(name)` selects the page engine; `router.override(adapter, name)`
sets a surface override, and `undefined` restores the page choice. Both return
Effects. Attachment assigns a context ID and returns an idempotent detach function.
Instances are created lazily on focus. `router.hotkeys.add(predicate, action)`
returns a removal function; there are no default router hotkeys.

## Key translation and layouts

`keycode` comes from the evdev column for `event.code`. A required manifest
`keyboard` field declares `{ layout: "us" | "default", passThrough: string[] }`;
pass-through entries are validated keysym names and skip engine processing.
Hangul declares the US layout and an empty pass-through list.

For `default`, `event.key` supplies the keyval: Latin-1 directly, a generated legacy
keysym where one exists, or `0x01000000 + codepoint`. Named DOM keys use a separate
mapping, including HangulMode/Lang1 → Hangul and HanjaMode/Lang2 → Hangul_Hanja.
For `us`, the bundled US table uses `event.code`, ignoring the OS's `event.key`.
Letters follow IBus's Shift/Lock rule: plain lowercase, Shift uppercase, Lock
uppercase, Shift+Lock lowercase. Other keys use Shift's second level; NumLock
selects the keypad's second level. This emulates the engine's requested layout;
it does not change the OS keyboard layout.

State carries Shift, Lock, Control, Alt/Mod1, NumLock/Mod2 and Meta/Mod4/Super/Meta.
AltGraph sets Mod5 and clears Control and Alt. Releases carry RELEASE and use the
same attachment mode as presses. Composing events, Dead keys, disabled/private
surfaces, manifest pass-through keys and keys without a ready enabled context are
excluded and retain native handling. Readiness requires Worker ready, successful
Init and the surface's instance/focus setup; typing remains native during startup.

The tables are generated from pinned xorgproto `keysymdef.h`, Chromium
`dom_code_data.inc` and xkeyboard-config US data. Their source licenses include
MIT-open-group and the Digital HPND-style notice, BSD-3-Clause, and
LicenseRef-xkeyboard-config respectively. They are not hand-maintained.
Canonical license texts and notices live in root `LICENSES/` and `NOTICES/`;
`prepack` copies the required texts/notices into the package and `postpack`
removes those generated copies. Keep upstream notices intact when regenerating.

## Synchronous keys and catch-up

Default attachment is synchronous. The key handler translates, posts
ProcessKeyEvent in SYNC mode, and spins for at most `budgetMs` (40 ms by default),
draining output until every record through `replyOutSeq` is present. It applies
ordered reply records in `adapter.batch()` before returning consumed or passthrough.
A consumed key is prevented and propagation stopped; a declined key keeps its
native browser default. This decision path is plain synchronous TypeScript;
service fibers consume synchronously enqueued logs/panel events off the key stack.

On budget exhaustion, the connection abandons the synchronous wait, rechecks for
a racing reply, and retains ownership of the key if it still has no reply.
The router prevents the event and queues later accepted keys. Keys arriving while
an asynchronous lifecycle/settings request occupies the connection also queue.
A doorbell completes the outstanding work; retained keys then run asynchronously,
one at a time. Declined retained keys are applied through `replayKey`, exactly once.
The per-engine FIFO is shared by all attachments and modes; its default bound is
64 retained events, including the in-flight key. The doorbell word is cleared
before draining to avoid losing a wake.

`EngineRegistry.request(name, request, ic)` already applies its reply records to
registered contexts. Its caller must not apply those records a second time.

## Asynchronous and manual surfaces

`router.attach(adapter, { keyMode: "sync" | "async" | "manual" })` selects handling
per attachment; the default is `sync`. Async attachments install keyboard/hotkey
capture but always submit eligible keys asynchronously. Manual attachments install
focus/blur/reset handling only: the editor owns keyboard and hotkey capture.
Synchronous native controls and async/manual editors can coexist on the same Router.
No concrete CodeMirror adapter ships yet.

For a manual attachment, call `router.keyAsync(adapter, event)` during the original
keyboard event dispatch, before any await. Accepted events are prevented and have
propagation stopped immediately, before the returned Promise settles. Excluded
events are untouched; do not unconditionally prevent them in the editor listener.

```ts
import type { RouterService, SurfaceAdapter } from "@ibus-web/core";

function attachEditor(router: RouterService, adapter: SurfaceAdapter) {
  const detach = router.attach(adapter, { keyMode: "manual" });
  const onKey = (event: KeyboardEvent) => {
    void router.keyAsync(adapter, event).catch(console.error);
  };
  adapter.element.addEventListener("keydown", onKey);
  adapter.element.addEventListener("keyup", onKey);
  return () => {
    adapter.element.removeEventListener("keydown", onKey);
    adapter.element.removeEventListener("keyup", onKey);
    detach();
  };
}
```

| Settlement    | Ownership and result                                                                        |
| ------------- | ------------------------------------------------------------------------------------------- |
| `consumed`    | Engine consumed the key; reply records are already applied.                                 |
| `replayed`    | Declined/crashed key fallback is already applied by the router. Never replay it again.      |
| `passthrough` | Key was excluded and never captured; native/editor handling remains available.              |
| `cancelled`   | Pending owner was detached/disposed; no pending key edit is applied to the removed surface. |

Adapter apply/replay callback failures reject explicit async calls. Background
callback failures and automatically captured async-call rejections are logged.
These are page callback failures, not engine crashes or reasons to restart it.

## Adapter and client duties

`SurfaceAdapter` supplies `element`, `capabilities()`, `contentType()`,
`surrounding(window)`, `caretRect()`, `batch(apply)`, `commit(text)`,
`deleteSurrounding(offset, count)`, `setPreedit(preedit)`, `replayKey(event)`,
`forwardKey(key)` and `onReset(listener)`. `onReset` returns its cleanup function
and reports external caret, selection or value changes; router-owned edits must
not cause a reset loop. Batch/apply callbacks run synchronously. A custom editor
can map each batch to its own transaction and undo step.

Adapter text offsets (cursor, anchor, preedit cursor/attributes and deletion) use
UTF-16 units; the router converts IBus Unicode code-point offsets at this boundary.
Surrounding text is a configurable ±1000-code-point window by default. It is sent
on focus, after commits and consumed keys, and on RequireSurroundingText, only
when the text/cursor/anchor snapshot changed. `caretRect()` returns viewport
coordinates or `undefined`; changed rectangles become SetCursorLocation requests.

The client owns the last visible preedit. Before FocusOut on blur, detach or engine
switch, and before Reset after an external edit, it commits visible COMMIT-mode
text through the adapter and clears preedit in one batch. CLEAR mode only clears;
Hangul uses it while its Hanja list is open. Preedit is decoration, never document
content. A crash clears preedit without committing it.

Capabilities start with PREEDIT_TEXT, AUXILIARY_TEXT, LOOKUP_TABLE, FOCUS and
PROPERTY, with unsupported adapter text capabilities removed and SURROUNDING_TEXT
added only when available. SYNC_PROCESS_KEY_V2 is never advertised: the reply
already orders output and declined synchronous keys retain their browser default.
Password inputs and current-password/new-password autocomplete surfaces never
focus their engine context; every key passes through. Other native inputs map
type/inputmode/autocomplete to purpose and hints before FocusIn.

`textareaAdapter(inputOrTextarea, { onPreedit })` implements the basic native
adapter. It uses setRangeText and input events, callback preedit, surrounding text
and code-point-aware fallback editing. Unsupported native selection APIs fall back
to end-of-value insertion. `caretRect()` is currently undefined. This adapter does
not provide a caret mirror/overlay, native undo integration, full clipboard behavior
or platform-complete navigation. Full native-text integration, overlays and undo
remain M1.4b work; contenteditable is later work.

## Settings, panel output and logging

`SettingsSource` supplies `snapshot(schemas): Promise<SettingsSnapshot>`,
`written(change)` and a `changes` Stream. Snapshot values are typed GVariant
variants indexed by schema ID and key. `SettingsSource.layer(initial)` and
`SettingsSource.Default` are in-memory. The registry sends snapshots on Init,
accepts SettingWritten and forwards changes to other live engines. IndexedDB
persistence, BroadcastChannel synchronization, schema metadata and the public
settings UI remain M1.4b work.

`router.panel` publishes tagged record/hide events with engine and context ID for
auxiliary text, lookup tables and properties; the example prints them. The default
panel and facade remain future work. `Logger.Default` maps GLib error/critical to
Error, warning to Warn, message/info to Info and the remaining levels to Debug,
annotating engine, inputContext and domain; hosts can replace the Logger service.

## Crashes, hangs and initialization

CoreConfig defaults are budgetMs 40, hangMs 2000, initHangMs 30000, replayLimit 64,
surroundingWindow 1000 and the transport's 64 KiB slot/256 KiB ring. Override them
with `CoreConfig.layer(partialValues)`. `ConnectionOptions.initHangMs` is optional
and defaults to 30000; the registry forwards CoreConfig's value. Both inactivity
budgets must be finite and positive. Only the protocol Init request uses initHangMs;
ordinary requests, including subsequent queued keys, use hangMs. A pending request
with no reply and no ring movement for its budget is a hang; ring movement refreshes
the inactivity window. These are progress bounds, not universal startup deadlines.

CRASHED, the host's crashed message, Worker errors, inactivity and queue overflow
terminate the connection. Owned keys are replayed in FIFO order, contexts lose
preedit and panel output is hidden. Restart is immediate, then exponential backoff
from 250 ms; three crashes in 60 seconds fail the engine and leave direct input.
After termination, unless storage was read-only, restart first waits up to 10 seconds
for the writer lock. A fresh Init uses current settings; instances return lazily
on focus. Composition is lost.

Persistent Hangul Init previously spent 7814.7 ms in an observed module load,
exceeding the ordinary two-second watchdog. A pinned-libhangul patch now gives each
Hanja table an owned 64 KiB stdio buffer (two tables, at most 128 KiB), preserving
the legitimate count/index passes and dictionary semantics. It removes the measured
small-read IndexedDB transaction amplification; it is not a backend cache change.

On an AMD Ryzen 9 9950X3D (32 logical CPUs), pinned Chromium 153.0.8010.12, the
following are single local Vite development observations. Each comparison used a
fresh context with empty IndexedDB; warm samples reused its installed distribution.

| Measurement                              | Before buffering | After buffering |
| ---------------------------------------- | ---------------: | --------------: |
| Cold persistent module initialization    |      3091.070 ms |      263.675 ms |
| Warm persistent module initialization    |      3322.530 ms |      154.710 ms |
| Cold navigation → ready                  |      3724.418 ms |      917.996 ms |
| Warm navigation → ready                  |      3780.032 ms |      640.914 ms |
| Cold measured read/metadata transactions |           25,263 |             411 |
| Warm measured read/metadata transactions |           25,273 |             421 |

A separate production smoke with a fresh Chromium context observed 843.6 ms to
ready while other checks ran. It is not part of the development comparison. Neither
sample establishes an all-browser or low-end-device startup guarantee. Costs outside
module initialization were not individually profiled. Faster page readiness remains
a preference; there is no additional factor-of-ten acceptance target.

## Demo and validation scope

The private example is [examples/hangul](../examples/hangul/README.md). From the checkout:

```sh
nix run .#demo
nix run .#demo -- --port 5174
```

The default port is 5173. The launcher builds the imported workspace packages and
serves Nix-built URL assets through Vite with isolation headers. `packages.demo`
is the production build and `checks.demo` its separate Chromium smoke. Preview
serves copied Brotli archives as opaque bytes without Content-Encoding: br.

Press Shift+Space to switch to Hangul, type gks for 한 and press F9 for Hanja
candidates. Preedit stays in its callback display until committed (for example,
on blur). The checkbox detaches/reattaches handling; native input remains usable
during startup and while disabled. The page prints panel records and engine/storage
state; it is not the full panel/settings facade. IBusEngineSimple has no compose
implementation, so Latin mode delegates ordinary typing to the browser.

The core Node and Chromium/Firefox browser gates cover router policy and synthetic
DOM integration through a real Worker/runtime/Hangul engine. The browser helper
simulates unprevented native defaults. Separate trusted Playwright interaction with
the development demo exercised composition, blur, Hanja and the checkbox. These
observations do not establish OS keyboard/layout, native undo, Safari, minimum-browser
coverage or persistent-storage recovery. The production smoke uses constructed keys.
See [testing.md](testing.md) for default versus explicit extended integrations;
focused tasks do not repeat every host/browser matrix. The milestone uses the
default `nix flake check`; later integration work covers broader trusted browser flows.
