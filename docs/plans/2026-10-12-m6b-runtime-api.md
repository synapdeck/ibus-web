# M6 Phase 6b: Runtime and API before release

## Goal

Land the protocol, module ABI and public API changes M6 needs before anything is published (spec
`docs/specs/2026-10-12-m6-release.md`, "6b: Runtime and API before release"): tagged errors from calls and on
`modulestate`, C++ exceptions contained to their module, a module shutdown call, a runtime ABI identity, a warmed thread
pool, `heapBytes` measured from the heap's base, and the backend's internals and the wake hook tidied. Runtime ABI and
protocol version stay 1.

## Tasks

1. **Tagged errors.** `packages/core/src/errors.ts` defines `EngineLoadFailed`, `RuntimeAbiMismatch`,
   `ProtocolMismatch`, `EngineCrashed`, `EngineHung`, `ProtocolError`, `StorageUnavailable`, `CreateEngineError` and
   `PrepareEngineError` as `Data.TaggedError`s, union `IbusWebError`; `select`, `prepare`, `engines` and the settings
   calls reject with them, `modulestate` carries `error` with `restarting` and `failed`, the facade and `ibus-web/effect`
   export them. Protocol's codec error becomes `CodecError`. Proven by `core-node` (a new `errors.test.ts`, the registry
   and connection tests), `ibus-web-node` (exports) and the facade's browser test.
2. **ABI identity.** `exports.json` carries `identity`, a SHA-256 over the ABI number and each library's name, version
   and symbols; the runtime constants and every engine manifest carry it as `runtimeIdentity`, and a mismatch refuses
   the module as `RuntimeAbiMismatch`. Proven by `ibus-runtime-exports-script` (identity tests), `protocol-node`
   (manifest schema), `worker-host-node` (startup refusals) and `ibus-runtime-load` (constants).
3. **The wake hook.** Patch 0017 refuses a `NULL` hook whatever `G_DISABLE_CHECKS` says and documents that a context
   must outlive concurrent wakeups; the smoke test counts criticals atomically. Proven by `glib-smoke` (`wakehook` line
   with a `NULL` hook refused) and `glib-patches`.
4. **C++ exceptions.** GLib patch 0019 adds `g_wasm_set_dispatch_hook()` around the marshaller calls in
   `g_closure_invoke` and `_g_closure_invoke_va` and the source dispatch in `g_main_dispatch`; libibus-web sets a C++
   `try`/`catch` trampoline that faults the engines and keeps `what()` (`ibusweb_fault_reason()`); the host drains output
   and ends the module with `EngineCrashed` (`FAULT`) carrying it. Proven by `glib-smoke` (`dispatchhook`),
   `libibus-web-tests` (`fault`, `dispatch`), `worker-host-node` (`engine fault`) and `core-node`; the hook's cost per
   signal emission is measured.
5. **Module shutdown.** `ibusweb_module_set_shutdown()`, request `Shutdown` (kind 6), sent after `Persist` on `unload`
   and the registry's end; Hangul registers `ibus_hangul_exit`. Proven by `libibus-web-tests` (`shutdown`),
   `worker-host-node` (`engine shutdown`), `core-node` (order of `Persist` and `Shutdown`), `protocol-node` (kinds) and
   `hangul-host`.
6. **The backend's internals.** wasmfs-idb's JavaScript calls back through function pointers, so
   `_wasmfs_idb_record_entry` and `_wasmfs_idb_set_string` are no longer exported. Proven by `ibus-runtime-load` (no
   `_wasmfs_idb_` export) and the wasmfs-idb checks.
7. **A warmed pool.** `ibusweb_warm_pool()` runs one thread on every idle pool Worker; the host calls it once the
   engine module has loaded and after each top-up. Proven by `libibus-web-tests` (`/pool/warm`) and
   `worker-host-node-integration` (`pool warmed once the engine loads`, and the scenarios unchanged).
8. **The heap from its base.** The conformance harness measures the allocator's peak from the heap's base (`mallinfo`'s
   `usmblks`), the manifest's `memory` stops adding the side module's static size, the `dylink.0` reader goes, and each
   engine's `heapBytes` is re-declared several MB over its measured peak. Proven by `tools-engine-manifest` and the
   engine host checks (`hangul-host`, `table-host`, `m17n-host`, `mozc-host`, `rime-host`).
9. **Per-Worker memory, re-measured.** The pool Worker and first-thread costs in `docs/runtime.md` re-measured against
   this host and runtime in Chromium, Firefox and Node. Proven by the recorded measurement.

## Decisions this phase makes where the spec is silent

- The GLib entry point is `g_wasm_set_dispatch_hook(GWasmDispatchHook)`, one process-wide hook set once; GObject reaches
  it through GLib's private vtable. A call the hook stops leaves a closure's return value as it was and keeps a source.
- `@ibus-web/protocol`'s codec error is renamed `CodecError`, so that `ibus-web/effect`, which re-exports core and
  protocol together, has one `ProtocolError`: the tagged one.
- The family's errors are Effect `Data.TaggedError` classes, which already are `Error` subclasses with `_tag`, so the
  facade re-exports the same classes and `instanceof` holds across both entry points. Common fields are `module`,
  `engine?` and `diagnostic?`; `EngineCrashed` adds `reason`. A crash of kind `worker` (the page lost its Worker)
  reports `HOST`; a hang is `EngineHung`.
- An unknown module name, a disposed facade and an unloaded module stay plain `Error`s: they are the caller's mistakes,
  not the engine's.
- A refused module (ABI or identity mismatch, protocol mismatch, a manifest the host can't take, an `Init` the runtime
  refuses, an `Init` too large for the slot) fails for good; any other start failure restarts as before.
- The runtime identity hashes canonical JSON (sorted keys, no spaces) of the ABI number and each library's name,
  version and symbols, so the export list and every linked library's version take part.
- `ESHUTDOWN` answers every request after `Shutdown`; `ENOTRECOVERABLE` every request after a fault.
- Warming runs as many threads as there are idle pool Workers, all created before any is joined, so each lands on a
  Worker of its own; the conformance instruments don't count those threads among the engine's.
- The dispatch hook's cost is measured with a microbenchmark of signal emissions run once in a scratch build, not as a
  check; the result is recorded in `docs/glib.md`.

## Departures from the spec

- None intended. The spec's "reason" for every error is the brief's `diagnostic` plus `EngineCrashed`'s `reason`, as the
  cross-phase names fix it.

## What the spike proved and what it didn't

The planner's spike (rebuilt from its transcript after the scratch directory was lost) proved, by building and running:
`glib-smoke` with the `dispatchhook` and `NULL` wake hook lines, `glib-patches`, `protocol-node` (424 tests),
`worker-host-node` (90 tests), `ibus-runtime-load`, `ibus-runtime-exports`, and the engine host checks' heap peaks from
the heap's base (Hangul 1.14 MB, table 1.50 MB, m17n 25.2 MB, Mozc 73.2 MB, Rime 99.8 MB with its page-size workload
peaking higher).

It didn't prove: `libibus-web-tests` (`fault` failed on a fatal warning before the test expected it), the
`engine fault` integration test (a call counted after the fault) and `pool-top-up` (warming threads counted as the
engine's), `wasmfs-idb-types` (`getWasmTableEntry` named in `EXPORTED_RUNTIME_METHODS` without being a dependency),
the dispatch hook's cost, the core and facade browser tests, and the per-Worker memory figures, which it never measured.
