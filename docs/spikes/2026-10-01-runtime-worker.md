# Runtime Worker spike (M0.4, R2)

- **Date:** 2026-10-01
- **Toolchain:** nixpkgs `8ce4ef6`, Emscripten 6.0.9 with the toolchain's
  patches (0014 among them, below), LLVM 22.1.8, Node v24.19.0; browsers
  from nixpkgs' `playwright-driver` 1.61.1: Chromium 149.0.7827.55 (headless
  shell) and Firefox 151.0
- **Build:** `nix build -L .#checks.x86_64-linux.runtime-spike-node` and
  `.#checks.x86_64-linux.runtime-spike-browser`
- **Question:** how the Worker host's wake word works. The host must sleep on
  one word and be woken both by the page (a request) and by GLib (the wake
  hook, from any pthread), and the page must never touch WASM memory (§9.2).

## Setup

`ibus-runtime` as packaged (`-sMAIN_MODULE=2 -sWASMFS=1`, pool of 4, fixed
32 MiB memory, 1 MiB stacks), with six spike side modules: `trivial`,
`thread`, `throw`, `fsync`, and two new ones, `proxy` and `timer`. Their
opcodes are one list in `sides/spike.h`; the build compiles a small program
against it for the WebAssembly target and runs it, printing the opcodes,
`IBUSWEB_PUMP_ERROR`, `ibusweb_wait()`'s `-ETIMEDOUT` and `struct mallinfo`'s
layout as `constants.json`, which the harnesses read. No TypeScript repeats
a C value.

The Worker host (`tests/spikes/runtime/src/worker/host.ts`) is the same code
for browser Workers and Node's `worker_threads`; under Node,
`src/node/worker-adapter.ts` supplies `self`, `postMessage`, `onmessage`,
`addEventListener("error")` and a browser-shaped `Worker`, and holds messages
until the entry module has set its handler, as a browser does. Its one
message carries the runtime's URL and compiled `WebAssembly.Module`, the
dedicated control `SharedArrayBuffer`, the side modules' bytes, the storage to
mount, the wait mode and the build's constants. It instantiates the runtime,
mounts storage (a WasmFS Node backend over a temporary directory at `/host`,
memory elsewhere), writes the side modules into WasmFS and loads them, calls
`ibusweb_runtime_init`, then serves requests for good.

The control buffer (`src/shared/control.ts`) is a 64-byte header of `Int32`
words, `state`, `reqSeq`, `reqLen`, `replyRet` and `wake`, followed by a
64 KiB slot that carries the request and then its reply. The page writes the
request, sets `state = REQUEST`, then increments and notifies `wake`; the host
dispatches, pumps, writes the reply, sets `state = REPLY` and notifies
`state`. The Node harness (`src/node/run.ts`) plays the page: it blocks in
`Atomics.wait` on `state`, as the keystroke path would spin.

Two host-level requests outside the runtime's opcode space are spike
instruments, not protocol: `stats` (Workers created since startup, idle
Workers, heap in use, requests served and how many of them found the host
asleep) and `yield` (a return to the host's event loop).

Both runtime builds run every scenario: the asserting build for correctness,
the released build for the timings quoted below. Numbers are from one run of
the check in the Nix sandbox unless noted; Node's `performance.now()` and
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

Under V2, `proxy-sync` and `spawn-nested` stayed pending until the harness
gave up after 3 s. That run's GTask, pushed from the host's own thread, did
complete, but only because `g_thread_pool_push()` blocks its caller in
`g_cond_wait` until GLib's `pool-spawner` thread has created the worker
(`glib/gthreadpool.c`), and that C futex wait runs the spawner's proxied
`pthread_create()`. `sync-proxied` now starts its GTask from another thread,
so the leg can fail: in the relay-less comparison below all three legs hang.

A variant that keeps the hook's word in WASM memory and has a relay Worker
forward its wakes to the control buffer (the committed `control` mode) needs
no Emscripten internals and wakes as fast, but sleeps outside the runtime too,
and fails `sync-proxied` the same way. It also serves as the relay-less
comparison for the request path: a page request reaches its host directly.

### Option 2: the host sleeps in the runtime (chosen)

`libibus-web` gains `ibusweb_wait(seen, timeout_ms)`: on the thread that owns
the default context, it sleeps in `emscripten_futex_wait` on the wake word in
WASM memory while the word holds `seen`, for the pump's delay. Emscripten ends
each futex wait on the runtime's own thread by running the calls proxied to
it, and wakes that thread for a new one (`do_proxy` →
`_emscripten_thread_notify`), so proxied calls complete while the host sleeps.
It always waits at least once, even when the word has already moved, so a
host woken often doesn't starve them. GLib's wake hook is unchanged: an atomic
add and `emscripten_futex_wake` on the word. The host treats any return but
0 and `-ETIMEDOUT` as a crash rather than spinning on it.

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

## Threads that end unjoined: an Emscripten fix

A thread that ends without a join on the host's thread (detached, joined from
another thread, or one of GLib's pool workers, which `g_thread_unref` detaches
and which end after their idle time) was cleaned up by
`_emscripten_thread_cleanup`, which from a pthread only posted
`CMD_CLEANUP_THREAD` to the host's event loop. Only there did
`returnWorkerToPool` put the Worker back and `_emscripten_thread_free_data`
free the thread's block: its 1 MiB stack, TLS and `struct pthread`. A host
that sleeps in `ibusweb_wait` and never returns to its event loop kept every
such Worker and block, so the first version of this spike gave the host an
event-loop turn between scenarios to stay within 32 MiB.

The toolchain now carries an Emscripten patch,
`modules/emscripten/patches/0014-pthread-cleanup-blocked-main.patch` (118 lines
added, 15 removed, in `libpthread.js`,
`library_pthread.c` and `threading_internal.h`), tracked upstream by the draft
`docs/upstream/emscripten-pthread-cleanup-blocked-main.md` (the symptom was
reported as #16763, closed without a fix). A thread that ends unjoined adds
itself to a lock-free list and wakes the main runtime thread with
`_emscripten_thread_notify()`; that thread drains the list in
`emscripten_main_thread_process_queued_calls()`, which every
`emscripten_futex_wait()` on it runs, `ibusweb_wait` included. The message is
still posted, for a main thread that is idle in its event loop, so that case
behaves as before. The exiting thread can't proxy the cleanup with
`emscripten_proxy_async()` instead: by then it has given up its thread state,
and proxying can block and allocate.

Freeing threads inside a wait on the main thread reaches one place in
Emscripten's own JavaScript: `dlopen()`'s sync lists the threads, then
proxies to each in turn, and a proxy can wait, even between checking the
list and touching the thread's struct. The patch holds cleanups off while
the sync goes through its list and runs them as soon as it is done; a thread
that ends meanwhile stays allocated and refuses the proxy, as in stock
Emscripten. Freed during the sync, it would be synced through its freed
struct, which can corrupt whatever reuses the memory or hang `dlopen()` on
the host's thread, `ibusweb_load_module()`'s path. `checks.emscripten-fixes`
covers both windows: a sync held up on an earlier thread, and one waiting
for the dlopen queue's mutex inside the proxy itself; without the hold, the
second aborts on Emscripten's `mailbox_refcount > 0` assertion.

Reclaiming threads early makes an existing race likelier. With dynamic
linking, a joined thread's "finished" message can arrive after a new thread
has taken over its `pthread_t`; it then marks the running thread finished,
and every later `dlopen()` skips that thread. `ibusweb_load_module()` loads
engines with `dlopen()` while GLib's pool threads may be alive, so this
affects the runtime. A second patch,
`0015-pthread-finished-mark-reused.patch` (15 lines added, 1 removed; draft
`docs/upstream/emscripten-pthread-finished-mark-reused.md`), marks a thread
only if it is still known and has actually exited. `checks.emscripten-fixes`
reproduces the race deterministically: without 0015, the new thread traps
calling into the module loaded after it started.

The harness no longer gives the host an event-loop turn between scenarios.
`thread-exit-blocked` runs five rounds of four detached threads
(`spawn-detached(4)`) with the host never returning to its event loop, and
fails unless the heap stays flat, no Worker is created in a round that starts
with enough idle Workers, and a final event-loop turn finds nothing left to
reclaim. The same harness on the
runtime built before the patch, and after it (released builds):

| | Round 1 | 2 | 3 | 4 | 5 | After one event-loop turn |
| --- | --- | --- | --- | --- | --- | --- |
| Before: heap in use (MiB) | 11.27 | 15.31 | 19.34 | 23.37 | 27.41 | 0.18 |
| Before: Workers created (idle at start) | 4 (0) | 4 (0) | 4 (0) | 4 (0) | 4 (0) | |
| After: heap in use (MiB) | 0.18 | 0.18 | 0.18 | 0.18 | 0.18 | 0.18 |
| After: Workers created (idle at start) | 0 (7) | 0 (7) | 0 (7) | 0 (7) | 0 (7) | |

Before the patch, round 1 already starts at 11 MiB, leaked by the earlier
scenarios' threads, and the run then aborts in `promise-proxied-fsync` with
"Cannot enlarge memory" at 32 MiB. After it, every scenario passes on both
builds without any event-loop turn.

## Results

Option 2 with the patch, released runtime unless marked. Each criterion is the
check's pass condition.

| Scenario | Criterion | Result | Measured |
| --- | --- | --- | --- |
| `dispatch` | 1000 `add` round trips back to back, every sum right | PASS | p50 9.3 µs, p99 27.1 µs, max 367.2 µs; 998 of 1001 requests found the host asleep (asserting: 6.3 / 31.9 / 395.2 µs) |
| `cold-wake` | 300 `add` round trips, each sent 2 ms after the last reply: every sum right, every request found the host asleep | PASS | p50 15.9 µs, p99 46.2 µs, max 46.7 µs; 301 of 301 asleep (asserting: 14.2 / 29.1 / 36.9 µs) |
| `thread-create-blocked` | `spawn(4)` and `spawn(5)` from a pump start and join every thread; `spawn-nested(idle + 1)` starts and joins every thread, creating at least one Worker beyond the pool | PASS | `spawn(4)` 70.9 ms, 0 new Workers; `spawn(5)` 94.3 ms, 1 new Worker; `spawn-nested(6)` with 5 idle Workers: joined 6 in 224.8 ms, 2 new Workers |
| `thread-exit-blocked` | above | PASS | heap 0.18 MiB in every round and after a turn; 0 Workers created, 7 idle at each round's start |
| `cross-thread-wake` | `idle-later(50)` ×20, host idle: attach → dispatch ≤ 20 ms | PASS | ε p50 0.050 ms, max 0.080 ms |
| `deadline` | `g_timeout_add(100)` ×5, no requests: 100 ± 10 ms | PASS | 100.096–100.234 ms; worst deviation 0.234 ms |
| `sync-proxied` | while the host sleeps: a call proxied synchronously to its thread, a thread creating threads, and a GTask that a thread other than the host's starts, all complete | PASS | `proxy-sync` 331 µs; `spawn-nested(2)` joined 2; GTask 2516 µs |
| `promise-proxied-fsync` | `fsync()` from a thread completes on each backend | PASS | WasmFS memory and Node backends: each within 2.2 ms (the poll's resolution) |
| `exceptions` | `throw` replies `-ECANCELED`, then `add` works | PASS | `-11` (`ECANCELED`), then 2 |
| `thread-crash` (a host of its own) | a thread that traps takes the host down: requests fail as crashed, and the host reports the thread's error | PASS | "a thread crashed: Error: unreachable", with the trapping thread's stack |

`spawn-nested(idle + 1)` is R2's case: a thread other than the host's creates
more threads than there are idle Workers, while the host sleeps in
`ibusweb_wait`. Each creation is proxied to the host, which runs it inside its
sleep and starts new Workers for the ones the pool can't cover. Under Node a
new Worker starts without the host's event loop; whether a browser starts one
is Task 6's to measure, with this same scenario.

For comparison, released runtime:

| Scenario | Option 2 | Idle host in `Atomics.waitAsync` | Relay-less (`control` mode) |
| --- | --- | --- | --- |
| `dispatch` p50 / p99 | 9.3 / 27.1 µs | 6.6 / 29.1 µs | 3.9 / 16.5 µs |
| `cold-wake` p50 / p99 | 15.9 / 46.2 µs | 12.2 / 45.5 µs | 11.3 / 54.8 µs |
| `cross-thread-wake` ε p50 / max | 0.050 / 0.080 ms | 0.028 / 0.044 ms | 0.103 / 0.292 ms |
| `deadline` worst deviation | 0.234 ms | 0.177 ms | 0.158 ms |
| `sync-proxied` | all complete | all complete | `proxy-sync`, `spawn-nested` and the GTask hang |

The `control` mode is not option 1: its host sleeps on the control buffer's
`wake` word, which the page bumps, so a request reaches it without the relay,
and GLib's wakes go through a relay the other way. It is the relay-less
baseline for the request path.

### What the relay costs

`dispatch` alone can't show what the relay costs: it sends each request as
soon as the last reply is taken, so whether the host (and, in option 2, the relay)
is already asleep when the request lands is a race, and its p50 mixes
requests served at once with ones that wake a thread that has barely slept.
The host now counts the requests that found it asleep: 994–1000 of 1001 in
every mode, so `dispatch` mostly measures a wake of a thread that has only
just gone to sleep.

`cold-wake` spaces its 300 requests 2 ms after each reply, so every request
finds the host asleep (301 of 301 every time) and, in option 2, the relay
asleep too. The host's count of requests that found it asleep is exact in
`control` mode, where `Atomics.wait` returns `"ok"` only after sleeping. In
`runtime` mode `ibusweb_wait()` can't tell a word that changed before it
slept from one that changed during, so the host reads the word again just
before the call and counts only a change after that read; one that lands in
the few instructions between that read and the futex wait still counts, so
the count can be slightly high there. The runs below predate that read and
counted every wait that returned 0, the same 301 of 301. Option 2's round
trip is page → relay → host; the relay-less `control` mode's is
page → host. Six runs of the released runtime outside the sandbox (Node
v24.20.0, nothing else running); each cell is the median over the runs of
that run's p50 or p99, with the range:

| | Relay-less (`control`) | Option 2 (`runtime`) | Difference per run (an upper bound on the relay's hop) |
| --- | --- | --- | --- |
| `cold-wake` p50 | 11.1 µs (9.8–12.3) | 14.7 µs (12.2–28.0) | +2.8 µs (+2.1 to +17.1) |
| `cold-wake` p99 | 35.6 µs (27.1–38.2) | 41.5 µs (37.0–50.7) | +8.3 µs (+5.1 to +12.5) |
| `dispatch` p50 | 5.7 µs (3.8–7.7) | 8.0 µs (6.4–9.9) | +2.4 µs (−1.1 to +6.1) |
| `dispatch` p99 | 16.3 µs (11.6–23.0) | 34.3 µs (25.3–39.9) | +15.9 µs (+11.0 to +22.1) |

The difference between the two modes is an upper bound on the relay's hop,
not the hop itself: option 2's host also sleeps inside the runtime, so it
pays for the call into WebAssembly, `emscripten_futex_wait` and the
`_emscripten_yield` that runs (and drains queued work) on each wake, where
the relay-less host sleeps in a plain `Atomics.wait`. So under Node the relay
and sleeping in the runtime together cost about 3 µs at the median and
8–16 µs at the 99th percentile, on round trips of 11–15 µs from cold and
6–8 µs back to back. That is small against a keystroke's budget, but it is a
cost, not noise. The sandbox run in the
tables above agrees at p50 (15.9 against 11.3 µs) and inverts at p99 (46.2
against 54.8 µs), which one run's tail can do. Browser numbers are Task 6's,
from the same scenario.

### Failures the host reports

- **A thread crashes.** A thread that traps sets Emscripten's crashed flag
  and wakes the host, whose next `_emscripten_yield` calls
  `emscripten_exit_with_live_runtime()`: the host's call into the runtime
  throws `"unwind"`, and the thread's own error reaches the host only
  afterwards, through its event loop, as an uncaught error. The host now posts
  `CRASHED` at once, then waits up to a second for that error and reports it;
  before, the page saw only "unwind". The real host must do the same.
- **The relay fails.** Without the relay a sleeping host never sees another
  request, and a sleeping host runs no event loop to hear the relay's `error`
  event. The relay therefore catches its own failure, posts `CRASHED` to the
  control buffer and bumps both words so the host wakes, reads it and reports
  the relay's error; an `error` the host does hear after startup (in its event
  loop, under `runtime-async` or a `yield`) does the same. A relay killed
  without running its own code (an out-of-memory kill, say) is still silent
  to a host asleep in `ibusweb_wait`: the page's reply timeout is the only
  backstop, and the real host needs one.
- A failed `WebAssembly.instantiate()` in the host's `instantiateWasm`,
  which Emscripten has no way to hear of, now fails the host's startup
  instead of leaving it waiting.

## Browsers

### Setup

`checks.runtime-spike-browser` runs the same host and scenarios in headless
Chromium and Firefox, offline in the Nix build sandbox, through Playwright
(`src/node/browser-run.ts`). A Node server (`src/node/server.ts`) serves the
page, the TypeScript build, the runtime and the side modules with
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` on every response, and
`application/wasm` and `text/javascript` types. The page (`src/page/page.ts`)
checks `crossOriginIsolated` (true in both browsers), compiles the runtime
with `WebAssembly.compileStreaming`, fetches the side modules' bytes, creates
the control buffer, starts the host with
`new Worker(url, { type: "module" })` and runs the scenarios over the
control buffer. It never sees the runtime's memory. Each host gets a browser
context of its own, so the origin's private file system starts empty every
time; the `opfs` scenario checks that it does.

The page's main thread can't `Atomics.wait` (Chromium: "Atomics.wait cannot
be called in this context"; Firefox: "waiting is not allowed on this
thread"), so it **spins** on the state word for each reply, as the
synchronous keystroke path would. A spin gives up after 8 s, longer than any
request takes when nothing waits for the page. The page then waits for the
reply with `Atomics.waitAsync`, its event loop running, and counts a reply
that only comes then as a *late reply* that fails its scenario. The host stays
in step, so the scenarios after it still run. For comparison, the page can
also wait for every reply with `Atomics.waitAsync`.

**Sandbox.** Chromium runs with its own sandbox: Playwright turns it off
unless asked, so the harness asks (`chromiumSandbox: true`), and it starts
inside the Nix build sandbox on this host, which allows user namespaces;
`--no-sandbox` isn't needed. Firefox hangs at startup, before Playwright's
handshake, unless it can write its XDG configuration and data directories
under `HOME` (a writable fontconfig cache alone isn't enough). A build's
`HOME` is `/homeless-shelter`, so `ibusWeb.testing.playwright.setup` points
`HOME` at a fresh temporary directory. The other variables are
`PLAYWRIGHT_BROWSERS_PATH` (nixpkgs' `playwright-driver.browsers` without
WebKit, ffmpeg or full Chromium), `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` and
`PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1`. No `MOZ_*` variable is needed.

Each browser runs three hosts: every scenario with the host asleep in
`ibusweb_wait`; a host with WasmFS's OPFS backend mounted at
`/engines/spike`, which runs `cold-wake`, `promise-proxied-fsync` (memory and
OPFS) and `opfs`; and the crash scenario on its own host. The OPFS backend
starts a thread of its own and keeps it for good, so with OPFS mounted one
pool Worker of four is taken (`opfs` reports 3 idle). That is why the thread
scenarios run on a host without it, as under Node. The released runtime also
runs the comparisons: the page waiting asynchronously, the idle host in
`Atomics.waitAsync`, and the relay-less `control` mode.

### Results against Node

Released runtime, one sandbox run each. Node is the same run of
`checks.runtime-spike-node`. Browsers coarsen `performance.now()`: the
host's and the page's step is 5 µs in Chromium and 20 µs in Firefox
(cross-origin isolated), against 0.02 µs in Node. So browser round-trip
times are multiples of the step; Firefox's p50s of 20 µs mean "one step".
The ε and deadline numbers come from GLib's clock, which reads the same
coarsened clock.

| Scenario | Node | Chromium 149 | Firefox 151 |
| --- | --- | --- | --- |
| `dispatch` p50 / p99 / max | 9.4 / 30.2 / 551 µs; 998 of 1001 asleep | 5 / 35 / 270 µs; 997 of 1001 | 20 / 60 / 360 µs; 1000 of 1001 |
| `cold-wake` p50 / p99 / max | 17.8 / 54.2 / 64.1 µs; 301 of 301 | 25 / 55 / 70 µs; 301 of 301 | 40 / 80 / 140 µs; 301 of 301 |
| `thread-create-blocked` | PASS: `spawn(4)` 73.7 ms; `spawn(5)` 92 ms, 1 new Worker; `spawn-nested(6)` joined 6 in 220 ms, 2 new | **FAIL (known):** `spawn(4)` 50 ms; `spawn(5)` joined 4: the fifth thread's new Worker never started (5 s timeout); `spawn-nested(5)` joined 3 | **FAIL (known):** `spawn(4)` 17 ms; `spawn(5)` joined 5, but its reply was late (8052 ms: it came only once the page stopped spinning); `spawn-nested` the same |
| `thread-exit-blocked` | PASS: 0.18 MiB every round, 0 Workers created | PASS: 2.2 MiB every round (the never-started threads' stacks from the scenario before), 0 created | PASS: 0.18 MiB, 0 created |
| `cross-thread-wake` ε p50 / max | 0.034 / 0.071 ms | 0.050 / 0.090 ms | 0.079 / 0.180 ms |
| `deadline` worst deviation | 0.259 ms | 0.25 ms | 0.32 ms |
| `sync-proxied` | PASS: `proxy-sync` 427 µs, GTask 2580 µs | PASS: 480 µs, 1780 µs | PASS: 3001 µs, 1221 µs |
| `promise-proxied-fsync` | PASS: memory 2.1 ms, Node backend 4.3 ms | PASS: memory 4.2 ms; OPFS 4.5 ms | PASS: memory 4.1 ms; OPFS 8.5 ms |
| `opfs` | (no OPFS) | PASS: write + `fsync` + close 0.75 ms, read back 0.75 ms, the same through the page's OPFS API | **FAIL (known):** write + `fsync` 6 ms, but the read back's reply was late (8001 ms) |
| `exceptions` | PASS | PASS | PASS |
| `thread-crash` | PASS | PASS: "Uncaught RuntimeError: unreachable" | PASS: "RuntimeError: unreachable executed" |
| `cold-wake` with OPFS mounted | | 30 / 75 / 110 µs | 20 / 100 / 180 µs |

The three known failures are listed in `browser-run.ts` with their reasons.
The check fails on any other failure, and also if a listed one passes. The
criteria are unchanged.

Comparisons (released runtime, same run):

| | Chromium | Firefox |
| --- | --- | --- |
| Page waits asynchronously: `cold-wake` p50 / p99 | 35 / 80 µs | 20 / 160 µs |
| Page waits asynchronously: `thread-create-blocked` | FAIL, as above | **PASS:** `spawn(5)` 46.5 ms, 1 new Worker; `spawn-nested(6)` joined 6, 2 new |
| Page waits asynchronously: `opfs` | PASS | **PASS:** read back 0.56 ms |
| Idle host in `Atomics.waitAsync`: `cold-wake` p50 / p99 | 35 / 200 µs | 40 / 80 µs |
| Idle host in `Atomics.waitAsync`: `thread-create-blocked` | FAIL on `spawn(5)` only: `spawn-nested(5)` joined 5 in 74.5 ms, 1 new Worker | FAIL: late replies, as with the host in `ibusweb_wait` |
| Relay-less (`control`): `cold-wake` p50 / p99 | 20 / 75 µs | 20 / 60 µs |
| Relay-less (`control`): `cross-thread-wake`, `sync-proxied` | FAIL: pending (leaked pool Workers, then Workers that never start) | FAIL: late replies (each new Worker waits for the page) |

Under the browsers' coarse clocks, the relay costs about what it costs
under Node. In Chromium, `cold-wake` p50 is 25 µs through the relay against
20 µs relay-less, and p99 55 against 75 µs. In Firefox it is 40 against
20 µs at p50 and 80 against 60 µs at p99. Each step is 5 µs (Chromium) or
20 µs (Firefox).

### Where the engines differ

Evidence from the runs above, and from a standalone page with nested Workers
and no runtime (scratch, not committed). In it, Worker A creates Worker C and
then blocks in `Atomics.wait` for 3 s, while Worker B, a child of A, runs
OPFS calls and creates Worker D. Each Worker timestamps its steps into a
shared buffer, once with the page's main thread free and once with it
spinning for 3 s:

| Step (ms after start) | Chromium, page free | Chromium, page spins | Firefox, page free | Firefox, page spins |
| --- | --- | --- | --- | --- |
| A: `new Worker(C)` returns | 0 | 0 | 0 | **3014** |
| C starts (A blocked until 3000) | **3003** | **3004** | 11 | 3032 |
| B: `getDirectory`, `getFileHandle` (present, absent) | 1–2 | 2 | 8–9 | 10–12 |
| B: sync access handle write, flush, close | 2 | 5 | 14 | 19 |
| B: `getFile()` | 2 | 5 | 14 | 20 |
| B: `File.arrayBuffer()` | 3 | 6 | 14 | **3008** |
| B: `new Worker(D)` returns | 3 | 6 | 15 | **3009** |

- **Chromium starts a Worker only once the thread that created it returns to
  its event loop.** A nested Worker created by a blocked Worker doesn't run
  until its creator unblocks (C at 3003 ms). The host never returns to its
  event loop, so a thread beyond the pool never starts. That holds both for
  one created in a pump that waits for it (`spawn(5)`) and for creations
  proxied to the host from another thread while it sleeps in `ibusweb_wait`
  (`spawn-nested`). With the idle host in `Atomics.waitAsync`, proxied
  creations do start (`spawn-nested(5)` joined 5); a pump that waits for its
  own new thread still can't. Under Node both start.
- **Firefox starts such a Worker while its creator is blocked, but
  `new Worker()` on a Worker returns only once the page's main thread is
  free.** While the page spins, the host stalls inside `new Worker()`, so
  any thread beyond the pool stalls the host until the page lets go
  (`spawn(5)`: the reply came only once the 8 s spin gave up, 1–96 ms after it).
  With the page waiting asynchronously, everything passes.
- **Firefox reads a file's Blob only with the page's main thread free.**
  WasmFS opens a file opened read-only on OPFS as a `Blob` (`getFile()`)
  and reads it with `arrayBuffer()`, so a read on OPFS stalls the host while
  the page spins (`opfs`: 8001 ms). Sync access handles (`O_WRONLY`,
  `O_RDWR`: write, `fsync`, close) don't depend on the main thread. Neither
  do `getDirectory` and `getFileHandle`. Chromium's OPFS doesn't depend on
  it at all.
- **`Atomics.wait` in module Workers, `Atomics.waitAsync`,
  `createSyncAccessHandle`:** present in both (the host reports
  `atomicsWaitAsync` and `syncAccessHandle` true, and the relay sleeps in
  `Atomics.wait`). The relay, a nested module Worker, starts in both.
- **Nested Workers:** pthreads are module Workers created from the host
  Worker by `new URL("ibus-runtime.js", import.meta.url)`. The pool starts at
  startup in both (host startup about 210 ms with the asserting runtime).
- **Timer resolution:** 5 µs (Chromium) and 20 µs (Firefox), in the page and
  in the host, cross-origin isolated.
- **A crash** reaches the host as the pthread Worker's `ErrorEvent`, which
  Emscripten rethrows (Node: an `Error`). The host now describes it by its
  message and source, and both browsers report the trapping thread's error.
- **Firefox warns** for every runtime instance: "The WebAssembly exception
  handling 'try' instruction is deprecated ... recompile to use the
  'try_table' instruction". `-fwasm-exceptions` emits the legacy encoding.
  Emscripten's `-sWASM_LEGACY_EXCEPTIONS=0` would emit `try_table`; not
  tried.
- `proxy-sync` (a call proxied synchronously to the sleeping host) takes
  1–3 ms in Firefox against 0.3–0.6 ms in Chromium and Node; not
  investigated.

### OPFS

On WasmFS's OPFS backend mounted at `/engines/spike`, both browsers do the
following. A file is absent at first (fresh storage; `-ENOENT`). It is
written, `fsync()`ed and closed on the host's thread, read back through the
runtime, and reads the same through the page's own OPFS API. The file
`promise-proxied-fsync` wrote from a pthread (which proxies to the
backend's own thread) reads back the same way. `promise-proxied-fsync` on
OPFS completes while the host sleeps: 4.5 ms in Chromium, 8.5–41.7 ms in
Firefox (the poll's resolution is 2 ms). The backend's thread is notified
directly, not through the host, because both browsers have
`Atomics.waitAsync`. Without it Emscripten would route the notification
through the sleeping host, and only the backend's 50 ms heartbeat would
recover it.

## Conclusions for the design

- **R2's wake question is settled:** option 2, as decided above. Emscripten
  proxies `pthread_create()` from every thread but the runtime's own, so a
  host that sleeps outside the runtime breaks GLib's thread pools, and option 1
  is out whatever delivers its buffer.
- **The "never returns to its event loop" premise holds with the Emscripten
  patch** (§5.2.4, §5.5.2, §6.2.3, R2): threads that end unjoined are
  reclaimed inside `ibusweb_wait`, and `thread-exit-blocked` guards it. The
  fallback, should the patch be dropped, is a brief, periodic return to the
  event loop while idle. Idling in `Atomics.waitAsync` also avoids the leak
  and passes every scenario under Node, and `waitAsync` is in both browsers
  tested.
- **In browsers the premise costs every thread beyond the pool** (open,
  needs a decision). Chromium never starts a Worker that a thread blocked
  for good created; Firefox starts it, but `new Worker()` on the host waits
  for the page's main thread. The choices: size the pool for the most
  threads ever alive at once, with `-sPTHREAD_POOL_SIZE_STRICT=2` to fail
  instead of hanging, and count the OPFS backend's thread; or idle in
  `Atomics.waitAsync`, so that in Chromium creations proxied while idle
  start (a pump that waits for its own new thread still can't); or both.
- **The page's spinning keystroke path can stall the host in Firefox**
  (open, needs a decision): `new Worker()` on the host and reads of OPFS
  files opened read-only wait for the page's main thread. A bounded spin
  that falls back to waiting asynchronously, as the harness does, unblocks
  them; so does keeping engine data reads off WasmFS's Blob path (open with
  `O_RDWR`, or read through a sync access handle).
- **§6.2.1** gains a `wake` word: the page bumps it after posting a request,
  and the relay watches it. The host sleeps on a word in WASM memory, not on
  the request word §5.2.4 names. Any relay must forward against the value it
  last forwarded, never a re-read.
- **§9.2 and §5.5 should name the relay as host-side.** It holds the runtime's
  memory (it writes the wake word there), so it belongs with the host, not the
  page; the page still touches only the control buffer.
- **Each engine Worker costs one more, small Worker,** the relay, which holds
  no runtime instance. It starts as a nested module Worker in Chromium 149
  and Firefox 151; WebKit wasn't run.
- **One relay per page could serve every engine** (an option for Task 7's
  budget, not built): a page-wide doorbell word that the page bumps after
  posting to any engine, per-engine sequence words in each control buffer,
  and one relay that, on each ring, scans the engines' sequence words and
  bumps the WASM wake word of each engine whose sequence moved. It would need
  every engine's memory, so it is still host-side, shared by the hosts.
- **R3/OPFS works in both browsers:** WasmFS's OPFS backend mounts,
  writes, `fsync`s and reads back from the host's thread and from pthreads
  while the host sleeps. It takes one pool Worker for good, and Firefox's
  read path depends on the page's main thread (above).
- **For Task 7 (memory):** the first run of a pool Worker costs about 18 ms
  (`spawn(4)`: 70.9 ms for four), and a Worker beyond the pool 23–67 ms more,
  since each loads the runtime and every side module.
- `fsync()` on WasmFS's memory and Node backends doesn't proxy at all, so
  Node can't exhibit R2's promise-proxied case. On OPFS it does, and it
  completes in both browsers.
