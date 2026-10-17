# @ibus-web/worker-host

The TypeScript that runs inside each ibus-web engine's dedicated Worker. It instantiates the WebAssembly IBus runtime,
starts the wake relay, mounts storage, installs the engine's data, and serves the page's requests over the shared-memory
transport.

The page doesn't import the host: it starts it by URL. `@ibus-web/worker-host/worker`, `@ibus-web/worker-host/relay` and
`@ibus-web/worker-host/storage` are the Worker scripts, the last the one that reads, exports and resets modules' storage
for the page. Keep `dist/worker/` together when deploying, since the host loads its relay and Brotli fallback from
beside itself, and the page finds the storage Worker beside the host. The package root exports only what the page shares
with the host: the control buffer layout, the messages and the storage names.

Most applications use [`ibus-web`](../ibus-web/README.md), which ships these scripts as `ibus-web/host/*`. The design is
in [docs/worker-host.md](https://github.com/synapdeck/ibus-web/blob/master/docs/worker-host.md).

The Worker scripts bundle `effect`, `brotli-dec-wasm` and `modern-tar`; their licenses are in `LICENSES/`. The package
itself is licensed under MIT OR Apache-2.0, at your option.
