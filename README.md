# ibus-web

IBus input-method engines, running in the browser.

ibus-web runs minimally modified C and C++ IBus engines as WebAssembly in Web Workers; ibus-hangul is the first. It
gives web pages a TypeScript library that does what the IBus daemon, the input-method module and the candidate panel do
on a Linux desktop. It translates DOM key events, routes them to the engine, applies the engine's preedit and commits to
text fields, and shows its candidates.

## How it fits together

- **The Worker side** is a WebAssembly runtime: a patched GLib and `libibus-web`, which carries IBus's engine API. It
  hosts one engine per dedicated Worker, loaded as a side module.
- **The page side** is `ibus-web` and the `@ibus-web/*` packages: key translation, routing, text-surface adapters and
  the default panel.

The two halves talk only through a versioned protocol over a dedicated `SharedArrayBuffer`. That boundary is also the
licensing boundary. Engines can be GPL, as Hangul is, but the page packages are MIT OR Apache-2.0: the page's bundle
never contains Worker, runtime or engine code, which load by URL from the Worker assets. The runtime
(`@ibus-web/runtime`, LGPL-2.1-or-later) and each engine (such as `@ibus-web/engine-hangul`, under the engine's license)
ship in packages of their own, which hold files a page serves, never code the page imports, so any page can use the page
packages. A page using ibus-web must be cross-origin isolated (COOP `same-origin`, COEP `require-corp`).

## Try it

You need [Nix](https://nixos.org/download/) with flakes enabled. The flake evaluates for x86_64-linux, aarch64-linux and
aarch64-darwin, but only x86_64-linux is built and checked.

```sh
nix run .#demo
```

Open http://127.0.0.1:5173. The page opens on Hangul: press Shift+Space to switch to Hangul input, type `gks` for 한,
and press F9 for Hanja candidates. The picker lists every engine the repository builds, and Ctrl+Space turns input
methods off and back on. The first build compiles the patched Emscripten toolchain, GLib and the engines, which takes a
while. [examples/demo](examples/demo/README.md) has the demo's other options.

## Packages

| Package                                              | What it is                                                                                      |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [`ibus-web`](packages/ibus-web)                      | The facade most pages use: `createIbusWeb`, the panel, and the Worker scripts                   |
| [`@ibus-web/core`](packages/core)                    | Key translation, routing, adapters and the Effect services under the facade                     |
| [`@ibus-web/panel`](packages/panel)                  | The framework-free candidate and property panel                                                 |
| [`@ibus-web/protocol`](packages/protocol)            | The wire protocol and its strict GVariant codec                                                 |
| [`@ibus-web/worker-host`](packages/worker-host)      | The TypeScript that runs inside each engine's Worker                                            |
| [`@ibus-web/runtime`](packages/runtime)              | The WebAssembly runtime every engine's Worker loads, built by Nix                               |
| [`@ibus-web/engine-hangul`](packages/engines/hangul) | The Hangul engine's WebAssembly module, data and manifest, built by Nix                         |
| [`@ibus-web/engine-table`](packages/engines/table)   | The LaTeX and X-SAMPA table engines' WebAssembly module, tables and manifest, built by Nix      |
| [`@ibus-web/engine-mozc`](packages/engines/mozc)     | Mozc with nixpkgs' UT dictionaries: its WebAssembly module, data and manifest, built by Nix     |
| [`@ibus-web/engine-m17n`](packages/engines/m17n)     | ibus-m17n with m17n-db's input methods: its WebAssembly module, data and manifest, built by Nix |

They aren't published to npm yet; [docs/ibus-web.md](docs/ibus-web.md) says how to build, pack and use them.

## Repository layout

| Directory   | What it holds                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| `packages/` | the packages above, plus the test-program runner and the shared tsconfig presets                             |
| `runtime/`  | the WebAssembly runtime: `libibus-web`, the IndexedDB storage backend, and the `ibus-runtime.wasm` link      |
| `engines/`  | one directory per engine: its overlay, patches and checks                                                    |
| `modules/`  | Nix several components share: the Emscripten toolchain, GLib, engines, TypeScript, testing, the flake and CI |
| `tools/`    | the build and check tools, one package each, with Nix beside those that need it                              |
| `examples/` | the demo of every module and its end-to-end tests                                                            |
| `docs/`     | how everything works and why, the design spec, and draft upstream reports                                    |

## Documentation

[docs/README.md](docs/README.md) indexes the topic pages. The design and remaining milestones are in the
[design spec](docs/specs/2026-09-26-ibus-web-design.md), and what is knowingly left open is in
[docs/known-gaps.md](docs/known-gaps.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems privately, as [SECURITY.md](SECURITY.md) describes.

## License

- The page-side packages, the Worker host, the runtime's storage backend and link, and the tools: MIT OR Apache-2.0, at
  your option ([LICENSE-MIT](LICENSE-MIT), [LICENSE-APACHE](LICENSE-APACHE)).
- `libibus-web` and the GLib patches: LGPL-2.1-or-later.
- The Emscripten patches: Emscripten's MIT OR NCSA.
- The pinyin comparison's corpus, `tools/pinyin-compare/corpus.tsv`: Tatoeba's sentences, under CC BY 2.0 FR.
- Each engine and its patches: the engine's own license. ibus-hangul is GPL-2.0-or-later, and its libhangul patch is
  LGPL-2.1-or-later, as libhangul is. The table engine is MIT OR Apache-2.0; its packed module is
  `(MIT OR Apache-2.0) AND BSD-2-Clause AND W3C`, for MARISA, linked in, and the LaTeX table's data from W3C's
  `unicode.xml`. ibus-m17n is GPL-2.0-or-later; its packed module is `GPL-2.0-or-later AND LGPL-2.1-or-later`, for
  m17n-lib, linked in, and m17n-db's input methods.

[REUSE.toml](REUSE.toml) is the authoritative per-path mapping, and every license text is in [LICENSES/](LICENSES).
Copyright 2026 Synapdeck, Inc.
