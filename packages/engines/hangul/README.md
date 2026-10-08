# @ibus-web/engine-hangul

The [ibus-hangul](https://github.com/libhangul/ibus-hangul) engine, built for ibus-web. The package holds no
JavaScript: it is the files a host serves and points ibus-web at, `manifest.json` and the WebAssembly module, data
archives and settings metadata it lists.

```ts
import { createIbusWeb } from "ibus-web";

const ibus = createIbusWeb({
  runtimeUrl: new URL("/ibus-web/runtime/ibus-runtime.js", location.href),
  engines: { hangul: new URL("/ibus-web/engines/hangul/manifest.json", location.href) },
});
```

Serve `dist/` as it is: the manifest names its files by relative URL, and the data archives are already
Brotli-compressed, so they must be served without `Content-Encoding: br`. Details are in
[docs/engines.md](https://github.com/synapdeck/ibus-web/blob/master/docs/engines.md).

`dist/` comes from the Nix build of the engine, never from this directory: `nix build .#npm.engine-hangul` packs
the tarball.

Licensed under GPL-2.0-or-later, which covers the module as a whole; libhangul, which it links, is
LGPL-2.1-or-later. Both texts are in `LICENSES/`.
