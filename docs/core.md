# Page core

`@ibus-web/core` is the page-side client: key translation, scoped engine lifecycle, input contexts, ordered output and
adapters. It imports only the protocol's transport and message definitions and the host's page-facing exports (the
control buffer, the storage names); Worker, runtime, Emscripten and engine implementations load by URL and stay outside
the page bundle. The package is MIT OR Apache-2.0, with the generated tables' source notices included in its
distribution.

## Layers and page lifetime

The page entry exports `Router`, `ModuleRegistry`, `CoreConfig`, `SettingsSource`, `Logger`, `PanelEvents`,
`Connection`, `textareaAdapter` and their public types. `@ibus-web/core/keys` exports translation and table helpers
without page services. `effect` is a peer dependency; the host application provides the shared copy.

Provide `Router.Default` with `ModuleRegistry.layer({ hostUrl, runtimeUrl, modules })`, then provide
`CoreConfig.Default`, `SettingsSource.Default`, `Logger.Default` and `PanelEvents.Default`. Keys in `modules` name
modules and map to their manifest URLs; they need not equal the manifest's name or any engine's name. `runtimeUrl` names
`ibus-runtime.js`, with `.wasm` and `constants.json` beside it. Serve every response with COOP `same-origin` and COEP
`require-corp` for cross-origin isolation.

Acquire and use the services inside a live Effect scope. Closing the scope removes listeners and terminates Workers; do
not return a router from an already-closed `Effect.scoped` program. The [demo](../examples/demo/src/main.ts) provides
the complete layer wiring and aborts its long-lived program on pagehide or HMR disposal.

An engine can hold state only in memory, such as the learning from a Rime commit, and a Worker that ends runs none of
its finalizers. So the registry has each ready Worker persist it (`Persist`) before ending the Worker, at `unload` and
when its scope closes, and when the page goes away (`pagehide`); `registry.persist()` does the same on demand. When
nothing else is on the module's wire, the request goes out at once and the page waits for its reply, up to `hangMs`, so
the engines have written their state before the handler returns and the browser goes on to end the Workers; a Worker
busy with a request gets it queued behind that one, which a page going away may not live to send. At `unload` and when
the scope closes, the Worker is ending for good, so `Persist` is followed by `Shutdown`, sent the same way, which has
each module release what it holds for its lifetime (Hangul's `ibus_hangul_exit`). The registry also sends it without
waiting when a navigation or close is about to start (`beforeunload`), and when the page is hidden (`visibilitychange`
to `hidden`), since a hidden page can be discarded with no further event but runs until then.

The wait at `pagehide` doesn't serve WebKit, whose Workers reach IndexedDB through the page's main thread: the wait
holds that thread, so an engine's write finishes only once the wait has given up, and the Workers end with it. There the
request sent at `beforeunload` is what persists, while the page still runs; by `pagehide` nothing is left to write, and
the wait returns at once. A page's own `unload` or `dispose()` in WebKit, with something left to write, waits `hangMs`
and loses it. The `beforeunload` listener is there only while a Worker runs, since Firefox keeps no page that has one in
its back/forward cache.

A module is one distribution: one manifest, one Worker. Its engines are the input methods inside it.
`router.select(module, engine?)` selects an engine, the module's first when `engine` is left out, and
`router.deselect()` returns every surface, overrides included, to native input while Workers stay loaded.
`router.override(adapter, { module, engine? })` sets a surface override, and `undefined` restores the page choice. All
three return Effects, and an unknown module or engine fails them before anything changes. Naming an engine needs the
module's manifest: a selection of a module whose manifest hasn't been read waits in the router's queue while
`registry.engines(module)` reads it, which starts no Worker, and until then surfaces following the page take native
input. A later selection supersedes a waiting one. `router.selection` is the page's `{ module, engine }` and
`router.selectionChanges` streams each change.

An engine whose descriptor names data of its own has it installed before it is first made in a Worker.
`registry.prepare(module, engine)` posts the Worker `PrepareEngine` once per Worker and engine, starting the Worker if
it hasn't, without selecting the module; an engine with no data of its own needs nothing, and `registry.isPrepared` says
whether an engine can be made as things are. While data installs, `registry.events` carries `install` events,
`{ module, engine, bytes, total }`, `bytes` reaching `total` only once all of it is installed. The router never holds
its mailbox for an install: a surface that wants an engine whose data isn't there stays on native input, as while its
module starts, and starts the download in the background, and once it ends the surfaces that still want the engine make
it. Focus changes, detaches and other selections go on meanwhile. `router.select(module, engine)` reports the new
selection at once, through `selectionChanges`, and resolves once the engine is made; a selection changed or undone while
its engine downloads resolves at once with nothing made, and the download goes on and stays installed.

Creating a surface's engine can fail. `CreateEngineError` carries the module, the engine and, as its `diagnostic`, the
engine's reason, taken from the runtime's `CreateEngineFailed` record when the engine gave one, or else the reply's
return value. Installing its data can fail too: `PrepareEngineError` carries the module, the engine and the Worker's
reason as its `diagnostic`, and is treated as `CreateEngineError` is, and a failed install is tried again at the next
prepare. `select` reconciles every surface and then rejects with the first such failure; `override` rejects with its
surface's. The selection stands, since the engine failed to start rather than the change failing. A surface whose engine
failed stays on native input, and its next focus tries again. A failure on focus has no caller to reject, so it is
logged as a warning. The module stays ready, and its other contexts keep working.

A surface keeps one input context per module, since the host holds one engine per context. Switching engine within a
module drains the context and sends `Disable` and `FocusOut` as any switch does, then `DestroyEngine`, and creates the
new engine in the same context and Worker with `CreateEngine{engine}`. Attachment assigns a context ID and returns an
idempotent detach function. Instances are created lazily on focus. `router.hotkeys.add(predicate, action)` returns a
removal function; there are no default router hotkeys.

`StorageApi.layer({ hostUrl, modules })`, beside the router, gives `usage()`, `export(module)` and `reset(module)` over
the modules' databases through a storage Worker started from beside the host's script
([storage.md](storage.md#the-host-api)); `reset` unloads a running module through the router and selects it again
afterwards. The registry's `start(name)` starts a module's Worker without enabling it, and `started(name)` says whether
it has been.

## Key translation and layouts

`keycode` comes from the evdev column for `event.code`. Each engine descriptor in the manifest has a required `keyboard`
field, `{ layout: "us" | "default", passThrough: string[] }`, and a context's keys follow its engine's. Pass-through
entries are validated keysym names and skip engine processing. Hangul declares the US layout and an empty pass-through
list.

For `default`, `event.key` supplies the keyval: Latin-1 directly, a generated legacy keysym where one exists, or
`0x01000000 + codepoint`. Named DOM keys use a separate mapping, including HangulMode/Lang1 → Hangul and HanjaMode/Lang2
→ Hangul_Hanja. For `us`, the bundled US table uses `event.code`, ignoring the OS's `event.key`. Letters follow IBus's
Shift/Lock rule: plain lowercase, Shift uppercase, Lock uppercase, Shift+Lock lowercase. Other keys use Shift's second
level; NumLock selects the keypad's second level. This emulates the engine's requested layout; it does not change the OS
keyboard layout.

State carries Shift, Lock, Control, Alt/Mod1, NumLock/Mod2 and Meta/Mod4/Super/Meta. AltGraph sets Mod5 and clears
Control and Alt. Releases carry RELEASE and use the same attachment mode as presses. Password/private surfaces,
composing events and Dead keys are excluded before engine processing. Registered hotkeys have their own readiness policy
and may run before an engine context is ready; manifest `passThrough` and unready-context exclusions govern engine
processing, not every registered hotkey. Readiness requires Worker ready, successful Init and the surface's
instance/focus setup; ordinary typing remains native during startup.

The existing `us` mode follows physical `event.code` positions, useful for conventional Hangul, while `default` follows
the translated `event.key`, useful for transliteration. The engine's Hangul keyboard setting is separate from the
operating system's layout. We have not validated arbitrary AZERTY, QWERTZ, Dvorak, Colemak or custom layouts, nor their
Dead-key, AltGr, shortcut and replay behavior. Detecting a host layout or offering a host override is a future design
option, not part of this API.

The tables are generated from pinned xorgproto `keysymdef.h`, Chromium `dom_code_data.inc` and xkeyboard-config US data.
Their source licenses include MIT-open-group and the Digital HPND-style notice, BSD-3-Clause, and
LicenseRef-xkeyboard-config respectively. They are not hand-maintained. Canonical license texts and notices live in root
`LICENSES/` and `NOTICES/`. `prepack` runs `tools/pack-licenses`, which copies the texts and notices the bundle needs
into the package's `LICENSES/` ([tooling.md](tooling.md#licenses-in-packed-packages)); `postpack` removes them. Keep
upstream notices intact when regenerating.

## Synchronous keys and catch-up

Default attachment is synchronous. The key handler translates, posts ProcessKeyEvent in SYNC mode, and spins for at most
`budgetMs` (40 ms by default), draining output until every record through `replyOutSeq` is present. It applies ordered
reply records in `adapter.batch()` before returning consumed or passthrough. A consumed key is prevented and propagation
stopped; a declined key keeps its native browser default. This decision path is plain synchronous TypeScript; service
fibers consume synchronously enqueued logs/panel events off the key stack.

On budget exhaustion, the connection abandons the synchronous wait, rechecks for a racing reply, and retains ownership
of the key if it still has no reply. The router prevents the event and queues later accepted keys. A key arriving while
an asynchronous lifecycle/settings request occupies the connection first reads that request's reply if it is already in
shared memory, since the doorbell message can trail the reply by a frame, and then continues synchronously. It queues
when the reply has not arrived, while a reset reservation holds keys, and behind retained keys. A doorbell completes the
outstanding work; retained keys then run asynchronously, one at a time. Declined retained keys are applied through
`replayKey`, exactly once. The router has already prevented their browser default, so `replayKey` returns false for a
shortcut whose browser action it cannot perform, and the router logs that loss as a warning in the `page-adapter`
domain. When a replayed key edits the field itself, as a replayed undo does, the reset it causes leaves the keys queued
behind it for the engine, after the Reset, since they were typed after that edit. The per-engine FIFO is shared by all
attachments and modes; its default bound is 64 retained events, including the in-flight key. The doorbell word is
cleared before draining to avoid losing a wake.

`ModuleRegistry.request(module, request, ic)` already applies its reply records to registered contexts. Its caller must
not apply those records a second time.

## Asynchronous and manual surfaces

`router.attach(adapter, { keyMode: "sync" | "async" | "manual" })` selects handling per attachment; the default is
`sync`. Async attachments install keyboard/hotkey capture but always submit eligible keys asynchronously. Manual
attachments install focus/blur/reset handling only: the editor owns keyboard and hotkey capture. Synchronous native
controls and async/manual editors can coexist on the same Router. No concrete CodeMirror adapter ships yet.

For a manual attachment, call `router.keyAsync(adapter, event)` during the original keyboard event dispatch, before any
await. Accepted events are prevented and have propagation stopped immediately, before the returned Promise settles.
Excluded events are untouched; do not unconditionally prevent them in the editor listener.

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

Adapter apply/replay callback failures reject explicit async calls. Background callback failures and automatically
captured async-call rejections are logged. These are page callback failures, not engine crashes or reasons to restart
it.

## Adapter and client duties

`SurfaceAdapter` supplies `element`, `capabilities()`, `contentType()`, `surrounding(window)`, `caretRect()`,
`batch(apply)`, `commit(text)`, `deleteSurrounding(offset, count)`, `setPreedit(preedit)`, `replayKey(event)`,
`forwardKey(key)` and `onReset(listener)`. `onReset` returns its cleanup function and reports external caret, selection
or value changes; router-owned edits must not cause a reset loop. Batch/apply callbacks run synchronously. A custom
editor can map each batch to its own transaction and undo step.

Adapter text offsets (cursor, anchor, preedit cursor/attributes and deletion) use UTF-16 units; the router converts IBus
Unicode code-point offsets at this boundary. Surrounding text is a configurable ±1000-code-point window by default. It
is sent on focus, after commits and consumed keys, and on RequireSurroundingText, only when the text/cursor/anchor
snapshot changed. `caretRect()` returns viewport coordinates or `undefined`; changed rectangles become SetCursorLocation
requests.

The client owns the last visible preedit. Before FocusOut on blur, detach or engine switch, and before Reset after an
external edit, it commits visible COMMIT-mode text through the adapter and clears preedit in one batch. CLEAR mode only
clears; Hangul uses it while its Hanja list is open. Preedit is decoration, never document content. A crash clears
preedit without committing it. Blur captures the identities of keys already accepted at the blur event; later keys from
a new focus interval cannot extend that drain. A focused reset holds newly accepted keys in the same engine FIFO until
Reset and snapshot refresh complete. Keys the context had already accepted are retired: they are replayed through
`replayKey` in the batch that commits the preedit, and when their replies arrive their edits, preedit, lookup table and
auxiliary text are dropped, since the reset ended the composition they belong to. Their RegisterProperties and
UpdateProperty records still apply: they describe the engine's modes, which no Reset sends again, and the key that opens
an engine's session is often the slow one a reset retires. A reset on an inactive or unready context reserves this
barrier when it becomes eligible again, after older cross-surface work has drained. Programmatic value and selection
edits are host-authoritative: reset uses the current host state. Pointerdown capture commits before a trusted click
moves the browser caret.

Capabilities start with PREEDIT_TEXT, AUXILIARY_TEXT, LOOKUP_TABLE, FOCUS and PROPERTY, with unsupported adapter text
capabilities removed and SURROUNDING_TEXT added only when available. SYNC_PROCESS_KEY_V2 is never advertised: the reply
already orders output and declined synchronous keys retain their browser default. Password inputs and
current-password/new-password autocomplete surfaces never focus their engine context; every key passes through. Other
native inputs map type/inputmode/autocomplete to purpose and hints before FocusIn.

`textareaAdapter(inputOrTextarea, { onPreedit })` renders preedit in a clipped, aria-hidden overlay. A temporary text
mirror accounts for font, box, direction, wrapping and scroll to locate the caret; `caretRect()` reports the native
caret or preedit cursor for SetCursorLocation. UTF-16 attribute ranges render underline and foreground/background
colors, including Hangul's white-on-black composition. The control value, native undo history and input events never
contain preedit. Focused commits and surrounding deletions in one batch become one native
`execCommand("insertText"/"delete")` edit with a browser input event and undo step. When the command is unavailable or
the field has lost focus, `setRangeText` plus a synthetic input event applies the edit without native undo. A command
that reports success but leaves the field short of the edit is finished the same way, over the span that still differs:
WebKit's `delete` keeps a textarea's final line break when the selection takes it in, which a replayed Delete over a
whole field hits. Production Chromium blur commit reaches this fallback; focused native undo and blur commit were tested
as separate behaviors. Unsupported selection APIs retain end-of-value fallback.

A replayed Ctrl chord (Command on Apple platforms) runs the editing command it names: Z undoes, Shift+Z redoes (as does
Ctrl+Y elsewhere), A selects all, and X and C cut and copy through `execCommand`, which needs the page's transient user
activation. Inside a batch, the batch's earlier edits are applied first so the command sees them, and the batch
continues from what the command leaves. Outside one, the command's change is reported through `onReset` once it returns,
as a native undo's would be. Paste has no page-side equivalent, since `execCommand("paste")` is refused in web content;
it and every other chord return false. These chords cannot be passed through before the engine replies, because engines
bind Ctrl chords of their own.

The callback remains optional; full clipboard/platform navigation and a concrete CodeMirror adapter are not shipped.

## Settings, panel output and logging

A setting the page handles is an instance, a schema id at one of its paths, plus a key: within one module a path holds
one schema, but modules can declare different schemas at one path. `SettingsSource` supplies
`snapshot(instances): Promise<SettingsSnapshot>`, `written(change)` and a `changes` Stream. Optional
`register(metadata)`, `write(change)` and `read(instance, key)` hooks support persistent sources while in-memory sources
remain valid. The registry reads a module's settings metadata before Init whatever the source, so a manifest that lists
`settingsSchemas` needs `settingsMetadata`. Snapshot values are typed GVariant variants indexed by path and key; a
change names its schema id, path and key. `settingsInstances(metadata)` lists a module's instances.
`SettingsSource.layer(initial)` is in-memory; `SettingsSource.Default` is a lazy `gsettings` IndexedDB source with
`BroadcastChannel("ibus-web:gsettings")` synchronization. It stores one origin-wide record keyed by path and key, with
GVariant type and normal-form `ArrayBuffer` bytes, and delivers a stored or broadcast change to every schema registered
at its path whose key accepts it, each with its own default on a reset. A snapshot hands over each record as it is
stored, even one another module's schema at the path stored outside this one's type, choices or range: the module's
settings backend skips it for the schema's default with one warning naming the path and key, and `get` returns the
default for it too. Values equal to the schema default delete the record. The registry loads metadata and snapshots
before Init, which declares every instance with its stored values, a schema with a `pattern` by the pattern and only its
instances that have values, and says the module's own files are read-only when its host reported `storage: read-only`,
accepts `SettingWritten` by mapping its path to the module's schema, and forwards changes to the other live modules that
declare the same instance. Cross-tab recipients update their live Workers without writing the record again. Concurrent
writes are last write wins per record; live tabs follow the last received broadcast, while future Init reads the
database. The Worker host never opens this database. See [ibus-web.md](ibus-web.md) for the public API.

`router.panel` publishes tagged record/hide events with module and context ID for auxiliary text, lazy lookup tables and
properties. The framework-free default panel consumes facade events; see [panel.md](panel.md). `Logger.Default` maps
GLib error/critical to Error, warning to Warn, message/info to Info and the remaining levels to Debug, annotating
module, inputContext and domain; hosts can replace the Logger service.

## Crashes, hangs and initialization

CoreConfig defaults are budgetMs 40, hangMs 2000, initHangMs 30000, replayLimit 64, surroundingWindow 1000 and the
transport's 64 KiB slot/256 KiB ring. Override them with `CoreConfig.layer(partialValues)`.
`ConnectionOptions.initHangMs` is optional and defaults to 30000; the registry forwards CoreConfig's value. Both
inactivity budgets must be finite and positive. Only the protocol Init request uses initHangMs; ordinary requests,
including subsequent queued keys, use hangMs. A pending request with no reply and no ring movement for its budget is a
hang; ring movement refreshes the inactivity window. These are progress bounds, not universal startup deadlines.

While a module's Worker runs on IndexedDB, the registry keeps a connection to each of the module's databases, on which
it opens no transaction, to hear a `versionchange` the host's own connections hear too: it closes its own at once and
has the host check its storage (`Connection.checkStorage()`, `CheckStorage` through the mail word), so that a host
asleep with nothing due posts `storage: closed` at once rather than when it next wakes
([storage.md](storage.md#version-changes)).

CRASHED, the host's crashed message, Worker errors, inactivity and queue overflow terminate the connection. Owned keys
are replayed in FIFO order, contexts lose preedit and panel output is hidden. Restart is immediate, then exponential
backoff from 250 ms; three crashes in 60 seconds fail the engine and leave direct input. After termination, unless
storage was read-only, restart first waits up to 10 seconds for the writer lock. A fresh Init uses current settings;
instances return lazily on focus. Composition is lost.

### Errors

Every failure an engine or its Worker causes is one of a family of Effect `Data.TaggedError`s in `errors.ts`, which are
`Error`s with a `_tag` (union `IbusWebError`, `isIbusWebError()`). Each carries `module`, `engine` where the failure was
one engine's, and `diagnostic`, the Worker's or the engine's own account; the message names all three.

| Error                | When                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EngineLoadFailed`   | The manifest or settings metadata couldn't be fetched or decoded, two names claim one distribution, or the Worker, runtime, module or `Init` failed to start. |
| `RuntimeAbiMismatch` | The host refused the module for another runtime's ABI.                                                                                                        |
| `ProtocolMismatch`   | The manifest's protocol version isn't the page's or the runtime's.                                                                                            |
| `EngineCrashed`      | The Worker crashed; `reason` is the `Crashed` record's (`TRAP`, `FAULT`, `RELAY`, `LOAD`, `HOST`), and a Worker the page lost is `HOST`.                      |
| `EngineHung`         | A request made no progress for its budget, or more keys waited than the replay queue holds.                                                                   |
| `ProtocolError`      | A request didn't fit the Worker's request slot; the diagnostic gives its size and the slot's.                                                                 |
| `StorageUnavailable` | The settings source failed a read, write or registration.                                                                                                     |
| `CreateEngineError`  | An engine failed to start (above).                                                                                                                            |
| `PrepareEngineError` | An engine's own data failed to install (above).                                                                                                               |

The registry's `select`, `prepare`, `engines` and `whenReady` fail with them, as do the settings API's calls. A module
refused for what it is (a mismatch, a manifest the host can't take, an `Init` the runtime refuses or that doesn't fit)
fails at once; any other start failure restarts as a crash does. A crash or hang has no call to reject, so the
registry's `state` event carries the error with `restarting` and `failed`: the one that ended the module, kept while it
restarts and, after a third crash, as the reason it failed. A restart that fails once its Worker has started ends that
Worker as a load crash but keeps the start's own error, such as `EngineLoadFailed` with its diagnostic. A module that
becomes ready clears it. An unknown module name, a disposed facade and an unloaded module are the caller's mistakes and
stay plain `Error`s.

Persistent Hangul Init previously spent 7814.7 ms in an observed module load, exceeding the ordinary two-second
watchdog. A pinned-libhangul patch now gives each Hanja table an owned 64 KiB stdio buffer (two tables, at most 128
KiB), preserving the legitimate count/index passes and dictionary semantics. It removes the measured small-read
IndexedDB transaction amplification; it is not a backend cache change.

On an AMD Ryzen 9 9950X3D (32 logical CPUs), pinned Chromium 153.0.8010.12, the following are single local Vite
development observations. Each comparison used a fresh context with empty IndexedDB; warm samples reused its installed
distribution.

| Measurement                              | Before buffering | After buffering |
| ---------------------------------------- | ---------------: | --------------: |
| Cold persistent module initialization    |      3091.070 ms |      263.675 ms |
| Warm persistent module initialization    |      3322.530 ms |      154.710 ms |
| Cold navigation → ready                  |      3724.418 ms |      917.996 ms |
| Warm navigation → ready                  |      3780.032 ms |      640.914 ms |
| Cold measured read/metadata transactions |           25,263 |             411 |
| Warm measured read/metadata transactions |           25,273 |             421 |

A separate production smoke with a fresh Chromium context observed 843.6 ms to ready while other checks ran. It is not
part of the development comparison. Neither sample establishes an all-browser or low-end-device startup guarantee. Costs
outside module initialization were not individually profiled. Faster page readiness remains a preference; there is no
additional factor-of-ten acceptance target.

## Demo and validation scope

The production demo is [examples/demo](../examples/demo/README.md), one page for every module in `ibusWeb.demo.modules`.
From the checkout:

```sh
nix run .#demo
nix run .#demo -- --port 5174
```

The default port is 5173. The launcher builds the imported workspace packages and serves Nix-built URL assets through
Vite with isolation headers. `packages.demo` is the production build and `checks.example-demo-smoke` its separate
Chromium smoke. Preview serves copied Brotli archives as opaque bytes without Content-Encoding: br. The build serves
every module under `/ibus-web/modules/<name>/`, beside a `modules.json` map from module name to manifest that the page
reads.

The page lists every engine of every module through `engines(module)` in its picker, in one group per language for a
module whose engines span several, and opens on the first module's default engine. Ctrl+Space, which the page binds
itself, toggles between `deselect()` and the last selection. For Hangul, press Shift+Space to switch to Hangul input,
type gks for 한 and press F9 for Hanja candidates. Preedit appears over the field until committed. The page uses the
facade, candidate/property panel and a metadata-driven persistent settings form for the selected module. Of the settings
paths that hold an engine's name, as m17n's and Rime's per-engine paths do, the form shows only the selected engine's. A
Data field shows the facade's `install` events while an engine's own data downloads. Opened as `/?properties=page`, the
page places none of the panel's properties and draws the focused engine's toggle properties as its own switches, which
send `PropertyActivate` through `sendPanelAction`, taking no focus. Its attachment control leaves native input usable
while disabled or starting. Restart starts a fresh Worker with default EN mode, then a trusted toggle resumes Hangul.
IBusEngineSimple has no compose implementation, so Latin mode delegates ordinary typing to the browser.

Core Node and Chromium/Firefox browser gates cover router policy and synthetic DOM integration. The separate production
Playwright suite uses trusted input in Chromium, Firefox and pinned Linux WebKit 26.6, including focused native undo and
cross-tab settings. Linux WebKit is not Safari 17.4 or macOS verification; OS keyboard layouts, physical devices and
paint latency remain unmeasured. See [testing.md](testing.md) for exact default and extended gates.
