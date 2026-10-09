# Using ibus-web

The packages aren't on npm yet. To try them, build their tarballs from this
repository with `nix build .#npm.all`, which holds one for each of `protocol`,
`worker-host`, `core`, `panel` and `ibus-web`, the runtime's and the Hangul
engine's. Install the five page packages' tarballs and the runtime's together,
with `effect`, their peer dependency.

The runtime and the engines are files the page serves, not code it imports, and
`ibus-web` doesn't carry them: serve `@ibus-web/runtime`'s `dist/` and pass its
`ibus-runtime.js` as `runtimeUrl`, and serve each engine package's `dist/` and
pass its `manifest.json`. They stay separate packages under their own licenses
(LGPL-2.1-or-later for the runtime, the engine's for an engine), so the page
packages stay MIT OR Apache-2.0. The facade's page bundle contains none of the
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

`createIbusWeb` acquires no services or storage until selection, an engine
listing or a settings operation, and only selection starts a Worker. Options are
`hostUrl?: URL`, required `runtimeUrl: URL`, required
`modules: Record<string, URL>` (each module's manifest, under a name the page
chooses), optional `settings: SettingsSourceService`,
`logger(entry)`, `logLevel` and partial core `config`. By default `hostUrl` is
the URL exported by `ibus-web/worker`. Keep its emitted `host/` directory together:
the host loads its relay and optional Brotli fallback beside the entry. A host
may pass its own deployed Worker URL. Put `ibus-runtime.wasm` and `constants.json`
beside `ibus-runtime.js`. Resolve manifest-relative module, `settings.json` and
data URLs from the served manifest, retaining its directory layout. Deploy the
complete engine distribution, including its `.wasm` and `data/*.tar.br` files.
Serve `.tar.br` as opaque bytes **without `Content-Encoding: br`** so the host can
decompress and validate the archive. Serve pages and assets with COOP
`same-origin` and COEP `require-corp`; the page must be cross-origin isolated for
the shared-memory transport. Cross-origin assets additionally need headers
compatible with that isolation policy.

`attach(inputOrTextarea, options?)` and `attachAdapter(adapter, options?)` return
idempotent detach functions. Each surface may use `keyMode: "sync" | "async" |
"manual"` (default `sync`). Native controls can coexist with editor-neutral
async/manual adapters on one facade and engine FIFO. In manual mode call
`keyAsync(adapter, event)` during the original key event dispatch; its Promise
returns `consumed`, `replayed`, `passthrough` or `cancelled`. A `replayed` fallback
is already applied exactly once; excluded `passthrough` events are untouched.
`select(module, engine?)` selects an engine of a module, the module's first when
`engine` is left out; switching engine within a module reuses its Worker. An
unknown module or engine rejects before anything changes. When a focused
surface's engine fails to start, `select` rejects with a `CreateEngineError`,
exported from `ibus-web` for `instanceof`, whose message carries the engine's
reason (for a table engine, the parser's `path:line: reason`). The selection
stands, since the engine failed to start, and that surface stays on native input.
`deselect()` returns every surface to plain browser input and keeps Workers
loaded; hosts bind their own shortcut for it, as there are no built-in hotkeys.
`selection` is the current `{ module, engine }` or `undefined`. `engines(module)`
reads and validates a module's manifest and resolves to its engine descriptors
(`name`, `displayName`, `languages`, `keyboard`) without starting a Worker.
`select`, `deselect`, `engines`, `unload(module)` and `dispose()` return Promises.
`debugRestart(module)` is a development-only way to terminate the actual Worker
and await recovery; it restores the selection only when `module` is the selected
one. No concrete CodeMirror adapter is provided.

`settings.schemas(module)` returns the generated schemas and keys. Use
`settings.get(module, schemaId, key)`, `set(module, schemaId, key, variant)` and
`reset(module, schemaId, key)` with typed GVariant variants, which `variant(type,
value)` builds for any type and `stringVariant`, `booleanVariant` and
`int32Variant` build for the `s`, `b` and `i` keys most settings have. The generated
metadata supplies defaults, descriptions and actual range/choice constraints.
Hangul's keyboard setting has no generated choices: hosts should render a
typed input rather than inventing an enum. The default source persists by origin;
the optional `settings` service can replace it. `modulestate`, `selectionchange`,
`storage`, `panel` and `log` are typed CustomEvent names; `selectionchange` carries
the new selection, or `null` after deselection. `logLevel` filters both `log`
events and the optional logger callback.

Subpaths: `ibus-web/effect` exposes the core services, adapters and protocol
schemas/types; `ibus-web/panel` exposes the framework-free panel and its
`style.css`; `ibus-web/worker` exports URL constants (`workerUrl`, `relayUrl`,
`brotliFallbackUrl`), not Worker implementation code. The scoped packages remain
available directly.

The built [demo](../examples/demo/README.md) shows the engine picker and a
deselect shortcut, the panel, settings form, restart and attachment controls. A host
distributing engine code and data should
publish a licenses page linked from its UI, listing the actual package and engine
licenses and shipping their required texts/notices. The core key-table notices
come from the pinned X11, Chromium and xkeyboard-config sources. Inspect each
published package's `LICENSES/` (license texts, notices and bundled
dependencies' licenses), the engine source bundle and
[bundle boundary check](testing.md#bundle-boundary) when preparing that page;
the demo itself does not supply a complete licenses page.
