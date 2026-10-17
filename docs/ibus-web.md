# Using ibus-web

The packages aren't on npm yet. To try them, build their tarballs from this repository with `nix build .#npm.all`, which
holds one for each of `protocol`, `worker-host`, `core`, `panel` and `ibus-web`, the runtime's and each engine's.
Install the five page packages' tarballs and the runtime's together, with `effect`, their peer dependency.

The runtime and the engines are files the page serves, not code it imports, and `ibus-web` doesn't carry them: serve
`@ibus-web/runtime`'s `dist/` and pass its `ibus-runtime.js` as `runtimeUrl`, and serve each engine package's `dist/`
and pass its `manifest.json`. They stay separate packages under their own licenses (LGPL-2.1-or-later for the runtime,
the engine's for an engine), so the page packages stay MIT OR Apache-2.0. The facade's page bundle contains none of the
Worker host, the runtime or an engine. A minimal native input integration is:

```ts
import { createIbusWeb } from "ibus-web";

const ibus = createIbusWeb({
  runtimeUrl: new URL("/assets/runtime/ibus-runtime.js", location.href),
  modules: { hangul: new URL("/assets/hangul/manifest.json", location.href) },
});
const detach = ibus.attach(document.querySelector("textarea")!);
await ibus.select("hangul");
// Later: detach(); await ibus.dispose();
```

`createIbusWeb` acquires no services or storage until selection, an engine listing or a settings operation, and only
selection starts a Worker. Options are `hostUrl?: URL`, required `runtimeUrl: URL`, required
`modules: Record<string, URL>` (each module's manifest, under a name the page chooses), optional
`settings: SettingsSourceService`, `logger(entry)`, `logLevel` and partial core `config`. By default `hostUrl` is the
URL exported by `ibus-web/worker`. Keep its emitted `host/` directory together: the host loads its relay and optional
Brotli fallback beside the entry. A host may pass its own deployed Worker URL. Put `ibus-runtime.wasm` and
`constants.json` beside `ibus-runtime.js`. Resolve manifest-relative module, `settings.json` and data URLs from the
served manifest, retaining its directory layout. Deploy the complete engine distribution, including its `.wasm` and
`data/*.tar.br` files. Serve `.tar.br` as opaque bytes **without `Content-Encoding: br`** so the host can decompress and
validate the archive. Serve pages and assets with COOP `same-origin` and COEP `require-corp`; the page must be
cross-origin isolated for the shared-memory transport. Cross-origin assets additionally need headers compatible with
that isolation policy.

`attach(inputOrTextarea, options?)` and `attachAdapter(adapter, options?)` return idempotent detach functions. Each
surface may use `keyMode: "sync" | "async" | "manual"` (default `sync`). Native controls can coexist with editor-neutral
async/manual adapters on one facade and engine FIFO. In manual mode call `keyAsync(adapter, event)` during the original
key event dispatch; its Promise returns `consumed`, `replayed`, `passthrough` or `cancelled`. A `replayed` fallback is
already applied exactly once; excluded `passthrough` events are untouched. `select(module, engine?)` selects an engine
of a module, the module's first when `engine` is left out; switching engine within a module reuses its Worker. An
unknown module or engine rejects before anything changes. When a focused surface's engine fails to start, `select`
rejects with a `CreateEngineError` whose `diagnostic` is the engine's reason (for a table engine, the parser's
`path:line: reason`). The selection stands, since the engine failed to start, and that surface stays on native input. An
engine whose descriptor names data of its own (a Rime schema's dictionaries) downloads and installs it the first time it
is selected, and `select` waits for it, while the surface stays on native input and other selections, focus changes and
detaches go on; a selection changed meanwhile resolves without making the engine, and the download still completes.
`prepare(module, engine)` does that ahead of selection, starting the module's Worker if it hasn't, so that the selection
later waits for nothing; an engine without data of its own needs nothing. While data installs, `install` events carry
`{ module, engine, bytes, total }`, unpacked bytes written of the total the storage lacked, `bytes` reaching `total`
only once all of it is installed; a second selection, or one in a later visit, installs nothing and sends none. A failed
install rejects `select` or `prepare` with a `PrepareEngineError` whose `diagnostic` is the Worker's reason; the
selection stands, as for a `CreateEngineError`, and the next focus tries again. `deselect()` returns every surface to
plain browser input and keeps Workers loaded; hosts bind their own shortcut for it, as there are no built-in hotkeys.
`selection` is the current `{ module, engine }` or `undefined`. `engines(module)` reads and validates a module's
manifest and resolves to its engine descriptors (`name`, `displayName`, `languages`, `keyboard`, and `data` for an
engine with data of its own) without starting a Worker. `select`, `deselect`, `engines`, `unload(module)`, `prepare` and
`dispose()` return Promises. Before `unload` or `dispose()` ends a Worker, and whenever the page goes away or is hidden,
the engines write what they keep only in memory, such as Rime's learning ([core.md](core.md#layers-and-page-lifetime));
the page needs no handler of its own for it. `debugRestart(module)` is a development-only way to terminate the actual
Worker and await recovery; it restores the selection only when `module` is the selected one. No concrete CodeMirror
adapter is provided.

`settings.schemas(module)` returns the generated schemas and keys. Each schema lists its `paths`: a fixed schema has
one, a relocatable schema one per instance. Use `settings.get(module, path, key)`, `set(module, path, key, variant)` and
`reset(module, path, key)` with typed GVariant variants, which `variant(type, value)` builds for any type and
`stringVariant`, `booleanVariant` and `int32Variant` build for the `s`, `b` and `i` keys most settings have. The
generated metadata supplies defaults, descriptions and actual range/choice constraints. Modules may declare different
schemas at one path, and `get` returns the default for a value another module's schema stored there that this one's
rejects, which is also what the module itself reads. Hangul's keyboard setting has no generated choices: hosts should
render a typed input rather than inventing an enum. The default source persists by origin; the optional `settings`
service can replace it. `modulestate`, `selectionchange`, `storage`, `panel`, `log` and `install` are typed CustomEvent
names; `selectionchange` carries the new selection, or `null` after deselection. A `storage` event's detail has the
`module`, a `state` and a `message`: `read-only` means learning is off in this tab, since another tab of the same origin
runs the module and writes its user data (Rime learns nothing, Mozc only for as long as the Worker runs), `ephemeral`
that user data lasts only as long as the Worker, for want of IndexedDB, `closed` that the module's databases were closed
under it, and `quota` that writes to them failed for want of space. `logLevel` filters both `log` events and the
optional logger callback.

`storage.usage()` reports every module's storage without starting a module's Worker: for each, `data`, the bytes of its
version's installed data, `userData`, the bytes of its own files, such as Rime's and Mozc's learning, and `engines`,
each engine's `data`, the bytes of its own data installed. `storage.export(module)` resolves to the module's user data
as a tar `Blob`, its entries named from the module's directory; the Worker writing the module's user data, in this tab
or another, writes what it keeps in memory first. `storage.reset(module)` deletes the module's user data, whoever holds
it, and leaves its installed data; a module that was running starts again, one that was selected is selected again, and
a field's override naming it is given back. They reject with `StorageUnavailable` when the storage can't be read or
reset, a reset among them when another tab keeps the database open for more than 10 s
([storage.md](storage.md#the-host-api)). The storage Worker they start is `host/storage.js`, beside the host's script.

Calls reject with the tagged errors of [core.md](core.md#errors), exported from `ibus-web` for `instanceof`:
`EngineLoadFailed`, `RuntimeAbiMismatch`, `ProtocolMismatch`, `EngineCrashed`, `EngineHung`, `ProtocolError`,
`StorageUnavailable`, `CreateEngineError` and `PrepareEngineError`, each an `Error` with a `_tag`, `module`, `engine`
where one applies and the Worker's `diagnostic`; `EngineCrashed` adds the crash's `reason`. A module that fails to start
rejects `select`, `prepare` and `engines` with its error, and the settings calls reject an unusable store with
`StorageUnavailable`. A crash or hang has no call to reject, so `modulestate`'s detail carries `error` with `restarting`
and `failed`. An unknown module name or a disposed facade rejects with a plain `Error`.

Rime's switches, such as simplified or traditional output (`rime:option:simplification`) and full-width characters
(`rime:option:full_shape`), are IBus properties: a page with its own controls reads them from `panel` events'
`RegisterProperties` and `UpdateProperty` records, sets one with
`sendPanelAction(module, ic, { _tag: "PropertyActivate", name, state })` for the focused context while the field keeps
the focus, and leaves `panel.properties` unplaced. [rime.md](rime.md#in-the-browser) has the details, and the demo does
it when opened as `/?properties=page`.

Subpaths: `ibus-web/effect` exposes the core services, adapters, tagged errors and protocol schemas/types;
`ibus-web/panel` exposes the framework-free panel and its `style.css`; `ibus-web/worker` exports URL constants
(`workerUrl`, `relayUrl`, `brotliFallbackUrl`, `storageUrl`), not Worker implementation code. The scoped packages remain
available directly.

The built [demo](../examples/demo/README.md) shows the engine picker and a deselect shortcut, the panel, settings form,
restart and attachment controls. A host distributing engine code and data should publish a licenses page linked from its
UI, listing the actual package and engine licenses and shipping their required texts/notices. The core key-table notices
come from the pinned X11, Chromium and xkeyboard-config sources. Inspect each published package's `LICENSES/` (license
texts, notices and bundled dependencies' licenses), the engine source bundle and
[bundle boundary check](testing.md#bundle-boundary) when preparing that page; the demo itself does not supply a complete
licenses page.
