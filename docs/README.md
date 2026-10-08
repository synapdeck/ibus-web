# ibus-web documentation

How ibus-web works, the constraints it lives under, and the evidence behind each choice. Each page
keeps its reasons beside the decisions they support, with measurements summarised along with the
conditions they were taken under. Start with the repository's [README](../README.md) for what
ibus-web is, and [CONTRIBUTING](../CONTRIBUTING.md) for how to work on it.

## Topics

| Page                             | Covers                                                                                                                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [toolchain.md](toolchain.md)     | Emscripten and its patches, the frozen library cache, the flags every object gets, the `pkgsWasm` cross package set, dynamic linking, the flake layout, the minimum versions |
| [glib.md](glib.md)               | `pkgsWasm.glib`: the patch series, function-pointer casts, the platform backends, GLib's own tests and their gate                                                            |
| [runtime.md](runtime.md)         | `libibus-web`, `ibus-runtime.wasm` and side modules; the pump and the wake design; the thread pool and its shares; fixed memory per Worker                                   |
| [engines.md](engines.md)         | Engine recipe overrides, FHS data, patch layers, callback audits and Hangul golden tests                                                                                     |
| [storage.md](storage.md)         | The WasmFS IndexedDB backend; engine data per version, its locks and installs; the writer lock; durability and costs                                                         |
| [worker-host.md](worker-host.md) | `@ibus-web/worker-host`: the host's scopes, request loop, relay and pool top-up, failures, storage and engine data, and its test suites                                      |
| [core.md](core.md)               | Page layers, key translation, sync/async routing, adapters, client policy, recovery and the Hangul demo                                                                      |
| [ibus-web.md](ibus-web.md)       | Installing and deploying the facade, its public API, Worker assets and settings                                                                                              |
| [panel.md](panel.md)             | Framework-free candidate/property panel, actions, placement and stylesheet                                                                                                   |
| [protocol.md](protocol.md)       | `@ibus-web/protocol`: strict GVariant codecs, schemas, generated artifacts, parity and decode measurements                                                                   |
| [testing.md](testing.md)         | GoogleTest, g_test and Vitest; the test-program runner; adding a test program; running tests locally                                                                         |
| [tooling.md](tooling.md)         | The dev shell, hk and its hooks, formatters and linters, TypeScript and pnpm, licenses in packed packages, editor language servers, CI and the binary cache                  |
| [known-gaps.md](known-gaps.md)   | What is knowingly left open, by area                                                                                                                                         |

## Specs

| Spec                                                             | Covers                                                                       |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [The design](specs/2026-09-26-ibus-web-design.md)                | Goals, architecture, protocol, licensing, build and the remaining milestones |
| [Repository organization](specs/2026-10-07-repo-organization.md) | The package, tsconfig, Nix and documentation layout                          |

## Beside the code

| Document                                                                              | Covers                                                                   |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [`packages/protocol/PROTOCOL.md`](../packages/protocol/PROTOCOL.md)                   | The generated message reference                                          |
| [`examples/hangul/README.md`](../examples/hangul/README.md)                           | Running the Hangul demo                                                  |
| [`tools/cast-audit/README.md`](../tools/cast-audit/README.md)                         | The function-pointer cast audit and its allow-lists                      |
| [`tools/ibus-test/README.md`](../tools/ibus-test/README.md)                           | The native IBus test adapter: trace protocol, running it, artifacts      |
| [`modules/emscripten/patches/README.md`](../modules/emscripten/patches/README.md)     | Each Emscripten patch: what it fixes, upstream status, when it can go    |
| [`modules/glib/patches/README.md`](../modules/glib/patches/README.md)                 | GLib's patch series                                                      |
| [`engines/hangul/patches/README.md`](../engines/hangul/patches/README.md)             | ibus-hangul's and libhangul's patch layers                               |
| [`runtime/libibus-web/src/ibus/README.md`](../runtime/libibus-web/src/ibus/README.md) | Which IBus sources are vendored and which are reimplemented              |
| [upstream/](upstream/README.md)                                                       | Draft reports for Emscripten, V8 and Node, and the order to post them in |

The packages' own READMEs (`packages/*/README.md`) are what npm shows for each one.
