# @ibus-web/engine-rime

[ibus-rime](https://github.com/rime/ibus-rime), the IBus front end of the [Rime](https://rime.im/) input method engine,
built for the browser with [librime](https://github.com/rime/librime) and its Lua and octagram plugins, and the schemas
of [plum](https://github.com/rime/plum)'s `rime-data`, of [rime-loengfan](https://github.com/CanCLID/rime-loengfan) and
of [rime-ice](https://github.com/iDvel/rime-ice), every one: pinyin, simplified and traditional, double pinyin, Zhuyin,
Cangjie, Quick, Wubi, Array, stroke, Cantonese, Shanghainese and other dialects, IPA and Middle Chinese, 47 engines in
one module, which runs in one Worker. The package holds no JavaScript: it is the files a host serves and points ibus-web
at, `manifest.json` and the WebAssembly module, data archives and settings metadata it lists.

```ts
import { createIbusWeb } from "ibus-web";

const ibus = createIbusWeb({
  runtimeUrl: new URL("/ibus-web/runtime/ibus-runtime.js", location.href),
  modules: { rime: new URL("/ibus-web/engines/rime/manifest.json", location.href) },
});
ibus.addEventListener("install", ({ detail }) => console.log(`${detail.engine}: ${detail.bytes} of ${detail.total}`));
await ibus.select("rime", "rime:luna_pinyin");
```

Each engine is one Rime schema, `rime:<schema_id>`; the default is `rime:rime_ice`, rime-ice's simplified pinyin.
`ibus.engines("rime")` lists them with their display names, such as `雾凇拼音 (Pinyin, simplified)`, and languages. The
module's start installs Rime's common data and its settings schemas, 1.0 MB compressed. Each engine's dictionaries are
data of its own, downloaded the first time it is selected, or when `ibus.prepare("rime", engine)` asks ahead, with
`install` events reporting the bytes: `rime:rime_ice`'s are 23.9 MB compressed, and all of them 82.2 MB.

Rime's settings are the fixed `org.freedesktop.ibus.engine.rime` schema at `/org/freedesktop/ibus/engine/rime/` and, for
each engine, `org.freedesktop.ibus.engine.rime.schema` at `/org/freedesktop/ibus/engine/rime/<schema_id>/`; the module
writes Rime's YAML from them. Each schema's switches, such as simplified and traditional output or full-width
characters, are IBus properties, `rime:option:<name>`, which a page can draw with its own controls.

Serve `dist/` as it is: the manifest names its files by relative URL, and the data archives are already
Brotli-compressed, so they must be served without `Content-Encoding: br`. The module's Worker takes 197 MiB of memory.
Details are in [docs/rime.md](https://github.com/synapdeck/ibus-web/blob/master/docs/rime.md).

`dist/` comes from the Nix build of the module, never from this directory: `nix build .#npm.engine-rime` packs the
tarball, and `npm.engine-rime.override { schemas = [ … ]; }` one with fewer schemas.

Licensed under
`GPL-3.0-or-later AND BSD-3-Clause AND GPL-3.0-only AND MIT AND Apache-2.0 AND BSD-2-Clause AND BSL-1.0 AND LGPL-3.0-only AND CC-BY-4.0`:
ibus-rime is GPL-3.0-or-later; librime, its plugins and their dependencies, linked into the module, are under the BSD,
MIT, Apache and Boost licences and librime-octagram under GPL-3.0-only; `rime-data`'s schemas are GPL-3.0-only,
LGPL-3.0-only, Apache-2.0 and CC-BY-4.0 between them, rime-loengfan is CC-BY-4.0 and rime-ice GPL-3.0-only. The
Cantonese dictionary `jyut6ping3`, from [rime-cantonese](https://github.com/rime/rime-cantonese), and `loengfan`, from
[rime-loengfan](https://github.com/CanCLID/rime-loengfan), are CanCLID's, under CC-BY-4.0, compiled into Rime's tables;
`LICENSES/ATTRIBUTION.md` credits them. Each licence text is in `LICENSES/`, and the copyright notices of librime,
librime-lua, LevelDB, yaml-cpp, glog, Lua, MARISA and rime-loengfan in `LICENSES/<component>/`.
