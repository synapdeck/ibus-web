# Runtime Worker spike (M0.4, R2)

- **Date:** 2026-10-01
- **Toolchain:** nixpkgs `8ce4ef6`, Emscripten 6.0.9, LLVM 22.1.8, Node v24.19.0
- **Build:** `nix build -L .#checks.x86_64-linux.runtime-spike-node`
- **Question:** how the Worker host's wake word works. The host must sleep on
  one word and be woken both by the page (a request) and by GLib (the wake
  hook, from any pthread), and the page must never touch WASM memory (§9.2).

## Setup

`ibus-runtime` as packaged (`-sMAIN_MODULE=2 -sWASMFS=1`, pool of 4, fixed
32 MiB memory, 1 MiB stacks), with six spike side modules: `trivial`,
`thread`, `throw`, `fsync`, and two new ones, `proxy` and `timer`.

The Worker host (`tests/spikes/runtime/src/worker/host.ts`) is the same code
for browser Workers and Node's `worker_threads`; under Node,
`src/node/worker-adapter.ts` supplies `self`, `postMessage`, `onmessage` and a
browser-shaped `Worker`. Its one message carries the runtime's URL and
compiled `WebAssembly.Module`, the dedicated control `SharedArrayBuffer`, the
side modules' bytes, the storage to mount and the wait mode. It instantiates
the runtime, mounts storage (a WasmFS Node backend over a temporary directory
at `/host`, memory elsewhere), writes the side modules into WasmFS and loads
them, calls `ibusweb_runtime_init`, then serves requests for good.

The control buffer (`src/shared/control.ts`) is a 64-byte header of `Int32`
words, `state`, `reqSeq`, `reqLen`, `replyRet` and `wake`, followed by a
64 KiB slot that carries the request and then its reply. The page writes the
request, sets `state = REQUEST`, then increments and notifies `wake`; the host
dispatches, pumps, writes the reply, sets `state = REPLY` and notifies
`state`. The Node harness (`src/node/run.ts`) plays the page: it blocks in
`Atomics.wait` on `state`, as the keystroke path would spin.

Both runtime builds run every scenario: the asserting build for correctness,
the released build for the timings quoted below. All numbers are from one run
of the check in the Nix sandbox unless noted; Node's `performance.now()` and
GLib's monotonic clock measure them.

## Options for the wake word

### Option 1: the hook notifies the control buffer

The wake hook would call JavaScript that does `Atomics.add`/`Atomics.notify` on
the control buffer's `wake` word, and the host would sleep on that word in
`Atomics.wait`. The crux is that the hook runs on whichever thread signals,
each pthread being its own Worker with its own JavaScript realm, so every
realm needs the buffer, including those of Workers Emscripten creates after
startup. Three ways to get it there were tried:

| Variant | How the buffer reaches pthread realms | Result |
| --- | --- | --- |
| V1 | `createRuntime({ ibuswebControl })`, read from `Module` | **Fails.** Pthread Workers run `Module()` with no settings; `CMD_LOAD` forwards only handler names, the memory, the module and the side modules. 54 hook calls on pthreads found no buffer, and `cross-thread-wake` failed its bound: attach to dispatch p50 18.0 ms, max 132.7 ms. |
| V2 | A `--js-library` postset puts the buffer into Emscripten's `sharedModules` map, which `CMD_LOAD` clones to every pthread Worker, pool and later ones alike | **Works for wakes:** no misses; `cross-thread-wake` p50 0.11 ms, max 0.40 ms (asserting build), with 16 Workers created after startup. But it rides on an undocumented, `MAIN_MODULE`-only variable and the contents of an internal message. |
| V3 | The host posts the buffer to each pthread Worker | Not run: it needs code in the pthread realm to receive the message (Emscripten's handler ignores messages without a known `cmd`) and a hook into Worker creation for Workers made later, the same internals as V2 and more. |

V1 and V2 were linked in scratch (the runtime's own link line plus
`--js-library` and a C file installing the hook), not committed.

**Every variant fails R2.** With the host asleep in `Atomics.wait`, a call
another thread proxies synchronously to the host's thread never runs:

- `pthread_create()` from any thread but the host's is such a call: Emscripten
  6.0.9's `__pthread_create_js` proxies it with `$pthreadCreateProxied`,
  `__proxy: 'sync'` (`src/lib/libpthread.js`), because only the thread that
  instantiated the runtime holds the Worker pool.
- That thread runs proxied calls only from its event loop (mailbox
  notification by `postMessage` or `Atomics.waitAsync`) or from inside
  `emscripten_futex_wait` (`_emscripten_yield` →
  `emscripten_main_thread_process_queued_calls`). Nothing proxied reaches
  JavaScript's `Atomics.wait` on another buffer.

`sync-proxied` under option 1 (V2, and the committed comparison below):
`proxy-sync` and `spawn-nested` stay pending until the harness gives up after
3 s. The GTask completes, but only because `g_thread_pool_push()` from the
host's thread blocks in `g_cond_wait` until GLib's `pool-spawner` thread has
created the worker (`glib/gthreadpool.c`), and that C futex wait runs the
spawner's proxied `pthread_create()`. A GTask started from any other thread
would hang.

A variant that keeps the hook's word in WASM memory and has a relay Worker
forward its wakes to the control buffer (the committed `control` mode) needs
no Emscripten internals and wakes as fast, but sleeps outside the runtime too,
and fails `sync-proxied` the same way.

### Option 2: the host sleeps in the runtime (chosen)

`libibus-web` gains `ibusweb_wait(seen, timeout_ms)`: on the thread that owns
the default context, it sleeps in `emscripten_futex_wait` on the wake word in
WASM memory while the word holds `seen`, for the pump's delay. Emscripten ends
each futex wait on the runtime's own thread by running the calls proxied to
it, and wakes that thread for a new one (`do_proxy` →
`_emscripten_thread_notify`), so proxied calls complete while the host sleeps.
It always waits at least once, even when the word has already moved, so a
host woken often doesn't starve them. GLib's wake hook is unchanged: an atomic
add and `emscripten_futex_wake` on the word.

The page still never touches WASM memory: a **relay Worker** started by the
host (`src/worker/relay.ts`) blocks in `Atomics.wait` on the control buffer's
`wake` word and, for each change, increments and notifies the wake word in
WASM memory. It never needs an event loop turn after startup, so the relay
exists without one. It must remember the value it last forwarded rather than
re-read the word after forwarding: the first version re-read it, lost a wake
that landed mid-forward, and hung at request 842 of 1000.

**Decision:** the wake word lives in WASM memory. GLib's hook bumps it from
any thread; the relay Worker bumps it for the page, which only ever writes the
control buffer; the host sleeps on it in `ibusweb_wait`. §9.2 holds.

## Results

Option 2, released runtime unless marked. Each criterion is the check's
pass condition.

| Scenario | Criterion | Result | Measured |
| --- | --- | --- | --- |
| `dispatch` | 1000 `add` round trips, every sum right | PASS | p50 6.0 µs, p99 25.7 µs, max 282.5 µs (asserting: 9.7 / 29.7 / 539.8 µs) |
| `cross-thread-wake` | `idle-later(50)` ×20, host idle: attach → dispatch ≤ 20 ms | PASS | ε p50 0.041 ms, max 0.087 ms |
| `deadline` | `g_timeout_add(100)` ×5, no requests: 100 ± 10 ms | PASS | 100.093–100.237 ms; worst deviation 0.237 ms |
| `thread-create-blocked` | `spawn(4)` and `spawn(5)` start and join every thread, no hang | PASS | `spawn(4)` 66.5 ms, 0 new Workers; `spawn(5)` 92.8 ms, 1 new Worker: creating beyond the pool **succeeds** under Node. Detached threads leak, see below. |
| `sync-proxied` | a call proxied synchronously to the host, a thread creating threads, a GTask, all complete while the host sleeps | PASS | `proxy-sync` 569 µs; `spawn-nested(2)` joined 2; GTask 1507 µs |
| `promise-proxied-fsync` | `fsync()` from a thread completes on each backend | PASS | WasmFS memory: within 2.2 ms; WasmFS Node backend: within 4.3 ms (the poll's resolution) |
| `exceptions` | `throw` replies `-ECANCELED`, then `add` works | PASS | `-11` (`ECANCELED`), then 2 |

For comparison, released runtime:

| Scenario | Option 2 | Idle host in `Atomics.waitAsync` | Option 1 (`control` mode) |
| --- | --- | --- | --- |
| `dispatch` p50 / p99 | 6.0 / 25.7 µs | 6.3 / 41.1 µs | 7.7 / 18.8 µs |
| `cross-thread-wake` ε p50 / max | 0.041 / 0.087 ms | 0.057 / 0.111 ms | 0.098 / 0.243 ms |
| `deadline` worst deviation | 0.237 ms | 0.192 ms | 0.165 ms |
| `sync-proxied` | all complete | all complete | `proxy-sync`, `spawn-nested` hang; GTask 829 µs |
| detached threads, 5 rounds of 4 | heap 4.2 → 20.4 MiB; Workers +0, 3, 4, 4, 4 | heap flat at 0.18 MiB; no new Workers | not run |

In Node the relay's hop doesn't show above run-to-run noise: a run outside the
sandbox measured option 2 at p50 6.3 µs against option 1's 3.9 µs. Browser
numbers are Task 6's.

### Detached threads leak under a host that never yields

A thread that ends without a join on the host's thread (detached, or joined
from another thread) is cleaned up by `_emscripten_thread_cleanup`, which from
a pthread posts `CMD_CLEANUP_THREAD` to the host's event loop. Only there does
`returnWorkerToPool` put the Worker back and `_emscripten_thread_free_data`
free the thread's block: its 1 MiB stack, TLS and `struct pthread`. A host
that never returns to its event loop keeps every such Worker and block.

`thread-create-blocked` measures it with rounds of four detached threads
(`spawn-detached(4)`), on a pool that started with four Workers plus the one
`spawn(5)` added:

| | Round 1 | 2 | 3 | 4 | 5 |
| --- | --- | --- | --- | --- | --- |
| Heap in use (MiB) | 4.21 | 8.24 | 12.28 | 16.31 | 20.35 |
| Workers created | 0 | 3 | 4 | 4 | 4 |

One 10 ms return to the event loop brings the heap back to 0.18 MiB; with one
before each round, three more rounds create no Workers and peak at 4.21 MiB.
A host that waits with `Atomics.waitAsync` while idle never leaks at all, and
passes every scenario.

Before the harness gave the host an event loop turn between scenarios, the
asserting runtime aborted with "Cannot enlarge memory arrays to size 34299904
bytes (OOM)": `cross-thread-wake`'s 20 detached `idle-later` threads, then
`spawn(4)` and `spawn(5)`, then four more detached threads exhausted the
32 MiB memory. Under Node each leaked Worker also holds a runtime instance
(some 45 MiB).

GLib creates such threads in normal use: `g_thread_unref` on a running thread
detaches it, GThreadPool workers end after their idle time, and GLib's own
pool creates its workers from the `pool-spawner` thread.

## Conclusions for the design

- **R2's wake question is settled:** option 2, as decided above. Emscripten
  proxies `pthread_create()` from every thread but the runtime's own, so a
  host that sleeps outside the runtime breaks GLib's thread pools, and option 1
  is out whatever delivers its buffer.
- **The "never returns to its event loop" premise does not hold** (§5.2.4,
  §5.5.2, §6.2.3, R2). The wake mechanism works, but threads that end without
  a join on the host's thread leak 1 MiB of WASM memory and a Worker each
  until the host's event loop runs. This needs a decision, among:
  1. Idle in `Atomics.waitAsync` on the same word, serving requests
     synchronously: measured above, no leak, same results, comparable
     latency in Node. Proxied calls then run from the event loop too. Needs
     `Atomics.waitAsync` in every target browser (Task 6 checks).
  2. Return to the event loop briefly while idle (a timer or a message every
     so often), keeping `ibusweb_wait` for the sleep itself.
  3. Patch Emscripten so a pthread's `_emscripten_thread_cleanup` is proxied
     through the system queue instead of `postMessage`, which `ibusweb_wait`
     already runs. Not tried; a small upstreamable change.
- **§6.2.1** gains a `wake` word: the page bumps it after posting a request,
  and the relay watches it. The host sleeps on a word in WASM memory, not on
  the request word §5.2.4 names. Any relay must forward against the value it
  last forwarded, never a re-read.
- **Each engine Worker costs one more, small Worker,** the relay, which holds
  no runtime instance. Nested dedicated Workers exist in all three target
  engines; Task 6 confirms the relay starts in each.
- **For Task 6 (browsers):** whether a Worker beyond the pool starts while
  the host is blocked (it does under Node); relay startup; OPFS, whose WasmFS
  backend proxies to a dedicated thread of its own rather than the host's,
  so `promise-proxied-fsync` must be repeated there; the page side cannot
  `Atomics.wait` on the main thread.
- **For Task 7 (memory):** the leak above until the event-loop decision is
  made; the 32 MiB budget is two dozen leaked threads; the first run of a
  pool Worker costs about 17 ms (`spawn(4)`: 66.5 ms for four), and a Worker
  beyond the pool 26–63 ms more, since each loads the runtime and every side
  module.
- `fsync()` on WasmFS's memory and Node backends doesn't proxy at all, so
  Node can't exhibit R2's promise-proxied case; it remains open for OPFS.
