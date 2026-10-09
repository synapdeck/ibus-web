# @ibus-web/engine-table

ibus-web's table engines, built for the browser: `latex`, which turns LaTeX commands such as `\alpha` into Unicode,
and `xsampa`, which turns X-SAMPA into IPA. Both are in one module and share one Worker. The package holds no
JavaScript: it is the files a host serves and points ibus-web at, `manifest.json` and the WebAssembly module, data
archives and settings metadata it lists.

```ts
import { createIbusWeb } from "ibus-web";

const ibus = createIbusWeb({
  runtimeUrl: new URL("/ibus-web/runtime/ibus-runtime.js", location.href),
  modules: { table: new URL("/ibus-web/engines/table/manifest.json", location.href) },
});
await ibus.select("table", "xsampa");
```

`latex` is the module's default; `ibus.engines("table")` lists both with their display names and languages.

Serve `dist/` as it is: the manifest names its files by relative URL, and the data archives are already
Brotli-compressed, so they must be served without `Content-Encoding: br`. Details are in
[docs/table.md](https://github.com/synapdeck/ibus-web/blob/master/docs/table.md).

`dist/` comes from the Nix build of the module, never from this directory: `nix build .#npm.engine-table` packs the
tarball.

Licensed under `(MIT OR Apache-2.0) AND BSD-2-Clause AND W3C`: the engine is MIT OR Apache-2.0, MARISA, linked into
the module, is BSD-2-Clause, and the LaTeX table, generated from W3C's `unicode.xml`, is W3C. Every text is in
`LICENSES/`; MARISA's is `LICENSES/marisa/COPYING.md`.
