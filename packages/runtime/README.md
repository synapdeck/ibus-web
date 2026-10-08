# @ibus-web/runtime

ibus-web's WebAssembly runtime: GLib, GObject and the GIO subset engines use, and `libibus-web`, which carries IBus's
engine API. Each engine's Worker loads it, and the engine as a side module into it. The package holds no code a page
imports: it is the files a host serves beside each other, `ibus-runtime.js`, `ibus-runtime.wasm` and `constants.json`.

```ts
import { createIbusWeb } from "ibus-web";

const ibus = createIbusWeb({
  runtimeUrl: new URL("/ibus-web/runtime/ibus-runtime.js", location.href),
  engines: { hangul: new URL("/ibus-web/engines/hangul/manifest.json", location.href) },
});
```

`@ibus-web/worker-host` depends on exactly this package's version, since the host and the runtime share an ABI. Details
are in [docs/runtime.md](https://github.com/synapdeck/ibus-web/blob/master/docs/runtime.md).

`dist/` comes from the Nix build of the runtime, never from this directory: `nix build .#npm.runtime` packs the tarball.

Licensed under LGPL-2.1-or-later, which covers the runtime as a whole; the runtime is a separate file a host can replace.
It links pcre2, zlib and libffi, whose licenses are in `LICENSES/` with GLib's and ibus-web's own.
