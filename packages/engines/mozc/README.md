# @ibus-web/engine-mozc

Mozc, Google's open-source Japanese input method, built for the browser with nixpkgs' UT dictionaries: its converter
and its own IBus frontend in one module, which runs in one Worker. The package holds no JavaScript: it is the files a
host serves and points ibus-web at, `manifest.json` and the WebAssembly module, data archives and settings metadata it
lists.

```ts
import { createIbusWeb } from "ibus-web";

const ibus = createIbusWeb({
  runtimeUrl: new URL("/ibus-web/runtime/ibus-runtime.js", location.href),
  modules: { mozc: new URL("/ibus-web/engines/mozc/manifest.json", location.href) },
});
await ibus.select("mozc", "mozc-on");
```

The module has Mozc's three engines: `mozc-jp`, the default, which starts in the user's chosen input mode; `mozc-on`,
which starts in hiragana; and `mozc-off`, which starts in direct input. `ibus.engines("mozc")` lists them with their
display names and languages. Mozc keeps its configuration, user dictionary and history in the module's own storage.

Serve `dist/` as it is: the manifest names its files by relative URL, and the data archives are already
Brotli-compressed, so they must be served without `Content-Encoding: br`. The data set is 35 MB compressed and the
module's Worker takes 136 MiB of memory. Details are in
[docs/mozc.md](https://github.com/synapdeck/ibus-web/blob/master/docs/mozc.md).

`dist/` comes from the Nix build of the module, never from this directory: `nix build .#npm.engine-mozc` packs the
tarball.

Licensed under `BSD-3-Clause AND Apache-2.0 AND NAIST-2003 AND MIT AND Unicode-DFS-2015 AND GPL-2.0 AND CC-BY-SA-4.0
AND GPL-2.0-or-later`: Mozc and the components its own credits name, and the UT dictionaries, each under its own
terms. `LICENSES/` holds the texts the repository has, Mozc's licence and credits in `LICENSES/mozc/`, and each UT
dictionary's licence in `LICENSES/mozcdic-ut-<name>/LICENSE`.
