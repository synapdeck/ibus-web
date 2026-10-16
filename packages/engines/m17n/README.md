# @ibus-web/engine-m17n

[ibus-m17n](https://github.com/ibus/ibus-m17n), the IBus front end of the [m17n](https://www.nongnu.org/m17n/)
input-method library, built for the browser with every m17n-db input method it offers: Indic, South-East Asian,
Vietnamese, Ethiopic, Cyrillic and many other scripts, and general-purpose methods such as Latin postfix diacritics, 197
engines in one module, which runs in one Worker. The package holds no JavaScript: it is the files a host serves and
points ibus-web at, `manifest.json` and the WebAssembly module, data archives and settings metadata it lists.

```ts
import { createIbusWeb } from "ibus-web";

const ibus = createIbusWeb({
  runtimeUrl: new URL("/ibus-web/runtime/ibus-runtime.js", location.href),
  modules: { m17n: new URL("/ibus-web/engines/m17n/manifest.json", location.href) },
});
await ibus.select("m17n", "m17n:hi:inscript");
```

Each engine keeps ibus-m17n's name, `m17n:<lang>:<name>`; the default is `m17n:t:latn-post`, Latin postfix diacritics,
which works on any keyboard. `ibus.engines("m17n")` lists them with their display names, such as "Hindi (inscript)", and
languages. Each engine's settings live at its own path, `/org/freedesktop/ibus/engine/m17n/<lang>/<name>/`, and an input
method's variables, where it has any, below it at `variables/`. A variable change reaches every input context made
afterwards, and an existing one at its next focus-out or reset; only a composition already under way keeps the old
value.

Serve `dist/` as it is: the manifest names its files by relative URL, and the data archives are already
Brotli-compressed, so they must be served without `Content-Encoding: br`. The data is 1.5 MB compressed and the module's
Worker takes 77 MiB of memory. Details are in
[docs/m17n.md](https://github.com/synapdeck/ibus-web/blob/master/docs/m17n.md).

`dist/` comes from the Nix build of the module, never from this directory: `nix build .#npm.engine-m17n` packs the
tarball.

Licensed under `GPL-2.0-or-later AND LGPL-2.1-or-later`: ibus-m17n is GPL-2.0-or-later, and m17n-lib, which the module
links, and m17n-db, whose input methods are its data, are LGPL-2.1-or-later. Both texts are in `LICENSES/`.
