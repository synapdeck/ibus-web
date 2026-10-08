# ibus-web

IBus input-method engines in the browser. ibus-web runs C and C++ IBus engines, such as
ibus-hangul, as WebAssembly in dedicated Workers. It gives your page what the IBus daemon, the
input-method module and the candidate panel give a Linux desktop: key handling, preedit, commits
and candidates for your text fields.

```ts
import { createIbusWeb, int32Variant } from "ibus-web";

const ibus = createIbusWeb({
  runtimeUrl: new URL("/assets/runtime/ibus-runtime.js", location.href),
  modules: { hangul: new URL("/assets/hangul/manifest.json", location.href) },
});
const detach = ibus.attach(document.querySelector("textarea")!);
await ibus.select("hangul");

// Settings take typed GVariant values: lay the candidate table out vertically.
await ibus.settings.set("hangul", "org.freedesktop.ibus.panel", "lookup-table-orientation", int32Variant(1));
```

The page must be cross-origin isolated (COOP `same-origin`, COEP `require-corp`). Deploy the
runtime, the engines' distributions and this package's `dist/host/` directory (exported as
`ibus-web/host/*`) as static assets.
`ibus-web/panel` adds the default candidate panel, `ibus-web/worker` exports the URLs of the
host's scripts, and `ibus-web/effect` exposes the underlying Effect services. `effect` 4 is a
peer dependency.

Deployment, the full API and settings are described in
[docs/ibus-web.md](https://github.com/synapdeck/ibus-web/blob/master/docs/ibus-web.md).

Licensed under MIT OR Apache-2.0, at your option. The Worker scripts in `dist/host/` bundle `effect`
and `brotli-dec-wasm`; their licenses are in `LICENSES/`. Engines are licensed separately
(ibus-hangul is GPL-2.0-or-later) and run only inside their Workers, never in your page's bundle.
