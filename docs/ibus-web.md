# Using ibus-web

Install `ibus-web` and its `effect` peer dependency with your package manager.
Build and serve the runtime, Worker host and engine distribution as URL assets;
the facade's page bundle does not contain their executable implementation. A
minimal native input integration is:

```ts
import { createIbusWeb } from "ibus-web";

const ibus = createIbusWeb({
  runtimeUrl: new URL("/assets/runtime/ibus-runtime.js", location.href),
  engines: { hangul: new URL("/assets/hangul/manifest.json", location.href) },
});
const detach = ibus.attach(document.querySelector("textarea")!);
await ibus.select("hangul");
// Later: detach(); await ibus.dispose();
```

`createIbusWeb` acquires no Worker or storage until selection or a settings
operation. Options are `hostUrl?: URL`, required `runtimeUrl: URL`, required
`engines: Record<string, URL>`, optional `settings: SettingsSourceService`,
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
`select(engine)`, `unload(engine)` and `dispose()` return Promises.
`debugRestart(engine)` is a development-only way to terminate the actual Worker
and await recovery. No concrete CodeMirror adapter is provided.

`settings.schemas(engine)` returns the generated schemas and keys. Use
`settings.get(engine, schemaId, key)`, `set(engine, schemaId, key, variant)` and
`reset(engine, schemaId, key)` with typed GVariant variants, which `variant(type,
value)` builds for any type and `stringVariant`, `booleanVariant` and
`int32Variant` build for the `s`, `b` and `i` keys most settings have. The generated
metadata supplies defaults, descriptions and actual range/choice constraints.
Hangul's keyboard setting has no generated choices: hosts should render a
typed input rather than inventing an enum. The default source persists by origin;
the optional `settings` service can replace it. `enginestate`, `storage`,
`panel` and `log` are typed CustomEvent names. `logLevel` filters both `log`
events and the optional logger callback.

Subpaths: `ibus-web/effect` exposes the core services, adapters and protocol
schemas/types; `ibus-web/panel` exposes the framework-free panel and its
`style.css`; `ibus-web/worker` exports URL constants (`workerUrl`, `relayUrl`,
`brotliFallbackUrl`), not Worker implementation code. The scoped packages remain
available directly.

The built [demo](../examples/hangul/README.md) shows the panel, settings form,
restart and attachment controls. A host distributing engine code and data should
publish a licenses page linked from its UI, listing the actual package and engine
licenses and shipping their required texts/notices. The core key-table notices
come from the pinned X11, Chromium and xkeyboard-config sources. Inspect the
published packages' `LICENSES/` and `NOTICES/`, engine source bundle and
[bundle boundary check](testing.md#bundle-boundary) when preparing that page;
the demo itself does not supply a complete licenses page.
