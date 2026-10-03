# ibus-web documentation

How the parts of ibus-web built so far work, the constraints they live under, and the evidence behind each
choice. Each page keeps its reasons beside the decisions they support, with measurements summarised along
with the conditions they were taken under. The design for what is still to come is the spec,
[`specs/2026-09-26-ibus-web-design.md`](specs/2026-09-26-ibus-web-design.md).

| Page                             | Covers                                                                                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [toolchain.md](toolchain.md)     | Emscripten and its patches, the frozen library cache, the flags every object gets, the `pkgsWasm` cross package set, dynamic linking, the minimum versions |
| [glib.md](glib.md)               | `pkgsWasm.glib`: the patch series, function-pointer casts, the platform backends, GLib's own tests and their gate                                          |
| [runtime.md](runtime.md)         | `libibus-web`, `ibus-runtime.wasm` and side modules; the pump and the wake design; the thread pool and its shares; fixed memory per Worker                 |
| [engines.md](engines.md)         | Engine recipe overrides, FHS data, patch layers, callback audits and Hangul golden tests                                                                   |
| [storage.md](storage.md)         | The WasmFS IndexedDB backend; engine data per version, its locks and installs; the writer lock; durability and costs                                       |
| [worker-host.md](worker-host.md) | `@ibus-web/worker-host`: the host's scopes, request loop, relay and pool top-up, failures, storage and engine data, and its test suites                    |
| [testing.md](testing.md)         | GoogleTest, g_test and Vitest; the test-program runner; adding a test program; running tests locally                                                       |
| [tooling.md](tooling.md)         | The dev shell, hk and its hooks, formatters and linters, TypeScript and pnpm, editor language servers, CI and the binary cache                             |
| [known-gaps.md](known-gaps.md)   | What is knowingly left open, by area                                                                                                                       |
| [upstream/](upstream/README.md)  | Draft reports for Emscripten, V8 and Node, and the order to post them in                                                                                   |

The Emscripten patches the toolchain carries are listed, with what each fixes and when it can go, in
[`modules/emscripten/patches/README.md`](../modules/emscripten/patches/README.md); GLib's in
[`modules/glib/patches/README.md`](../modules/glib/patches/README.md).
