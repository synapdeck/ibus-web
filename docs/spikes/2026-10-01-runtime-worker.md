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

`ibus-runtime` as packaged (`-sMAIN_MODULE=2 -sWASMFS=1`, a pthread pool of
11 with `-sPTHREAD_POOL_SIZE_STRICT=2`, both under "Threads beyond the pool"
below, fixed 32 MiB memory, 1 MiB stacks), with six spike side modules: `trivial`,
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

Three host-level requests outside the runtime's opcode space are spike
instruments, not protocol: `stats` (Workers created since startup, idle
Workers, heap in use, requests served and how many of them found the host
asleep, the pool's top-ups and the host's event-loop turns), `yield` (a
return to the host's event loop) and `topUp` (holds the pool's top-ups off,
or allows them again).

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
| `dispatch` | 1000 `add` round trips back to back, every sum right | PASS | p50 9.8 µs, p99 39.8 µs, max 302.7 µs; mean of ten batches of 100 timed whole 11.6 µs (9.6–17.0); 998 of 1001 requests found the host asleep (asserting: 9.4 / 30.5 / 310.4 µs, mean 11.6 µs) |
| `cold-wake` | 300 `add` round trips, each sent 2 ms after the last reply: every sum right, every request found the host asleep | PASS | p50 27.6 µs, p99 44.3 µs, max 47.8 µs, mean 25.9 µs; 301 of 301 asleep (asserting: 17.4 / 51.7 / 76.0 µs, mean 18.9 µs) |
| `thread-create-blocked` | a burst of the side modules' share of the pool (4) alive at once, `spawn(4)` from a pump and `spawn-nested(3)` from a thread, starts and joins every thread, creating no Worker and never returning the host to its event loop | PASS | 11 of 11 Workers idle; `spawn(4)` 71.3 ms, `spawn-nested(3)` 2.2 ms; 0 Workers created, 0 event-loop turns |
| `pool-top-up` | with as many threads alive as the shares plan for (8) and the host idle, the pool stays as it is with its 3 spare Workers idle; with one more alive, the host tops it up by one Worker, back to 3 idle | PASS | peak: 8 alive, 3 of 11 idle, 0 Workers created, 0 top-ups, 0 event-loop turns; one more: a top-up of 1 Worker in 73.8 ms, 3 of 12 idle |
| `thread-exit-blocked` | above, with rounds of `spawn-detached(4)` | PASS | heap 0.18 MiB in every round and after a turn; 0 Workers created, 12 idle at each round's start |
| `cross-thread-wake` | `idle-later(50)` ×20, host idle: attach → dispatch p50 ≤ 20 ms and max ≤ 200 ms (max ≤ 20 ms by hand, with `--compare`) | PASS | ε p50 0.050 ms, max 0.080 ms |
| `deadline` | `g_timeout_add(100)` ×5, no requests: 100 ± 10 ms | PASS | 100.096–100.234 ms; worst deviation 0.234 ms |
| `sync-proxied` | while the host sleeps: a call proxied synchronously to its thread, a thread creating threads, and a GTask that a thread other than the host's starts, all complete | PASS | `proxy-sync` 557 µs; `spawn-nested(2)` joined 2; GTask 2294 µs, after which GLib keeps 3 Workers |
| `promise-proxied-fsync` | `fsync()` from a thread completes on each backend | PASS | WasmFS memory and Node backends: each within 2.2 ms (the poll's resolution) |
| `exceptions` | `throw` replies `-ECANCELED`, then `add` works | PASS | `-11` (`ECANCELED`), then 2 |
| `thread-crash` (a host of its own) | a thread that traps takes the host down: requests fail as crashed, and the host reports the thread's error | PASS | "a thread crashed: Error: unreachable", with the trapping thread's stack |

`spawn-nested` is R2's case: a thread other than the host's creates threads
while the host sleeps in `ibusweb_wait`. Each creation is proxied to the host,
which runs it inside its sleep on a Worker from the pool. The rows for
`thread-create-blocked`, `pool-top-up` and `thread-exit-blocked` are from a
run with the pool of 11 ("Threads beyond the pool", under Browsers); those
for `dispatch`, `cold-wake` and `sync-proxied` from one with a pool of 8,
the shares alone; the others from a run before the pool was sized from
shares. Under Node, Emscripten ignores
`PTHREAD_POOL_SIZE_STRICT` and starts a Worker beyond the pool whenever one
is needed, so the scenario that exhausts the pool runs in browsers only.

For comparison, released runtime, from the run before the pool was resized:

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
against 54.8 µs), which one run's tail can do. Browser numbers, from the
same scenario, are under "Browsers" below.

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
synchronous keystroke path would. A spin gives up after 1 s, over ten times
the longest any request takes when nothing waits for the page (a pump that
starts four threads: 50 ms in Chromium, 72 ms under Node). The page then
waits for the reply with `Atomics.waitAsync`, its event loop running, and
counts a reply that only comes then as a *late reply* that fails its
scenario. The host stays in step, so the scenarios after it still run.

The design's keystroke path (D6) spins for at most 40 ms, then consumes the
request and replays it asynchronously. The harness models it: each scenario
reports how many of its calls held the page's thread longer than 40 ms, and
the longest. A result records whether it would have passed but for its late
replies, and which calls were late.

**Known failures** are listed in `browser-run.ts` by browser, run and
scenario, each with a matcher for its cause: a failure counts as known only if
the matcher recognises it. The check fails on any other failure, on a known
failure that passes or fails another way, and, run without `--browser` or
`--scenario`, on a listed failure that wasn't run. One remains (`opfs-read-only`
in Firefox, below). The criteria are unchanged, but for the thread scenarios
whose design changed (next section).

**Sandbox.** Chromium runs with its own sandbox: Playwright turns it off
unless asked, so the harness asks. `ibusWeb.testing.playwright.chromiumSandbox`
(default true) passes `IBUS_WEB_CHROMIUM_SANDBOX` to the harnesses through
`ibusWeb.testing.playwright.env`; a builder that forbids unprivileged user
namespaces, which Chromium's sandbox needs, sets it to false. On this host the
Nix build sandbox allows them. A browser that fails to launch is reported in
the tables as such, and the other browser still runs. Firefox hangs at
startup, before Playwright's handshake, unless it can write its XDG
configuration and data directories under `HOME` (a writable fontconfig cache
alone isn't enough). A build's `HOME` is `/homeless-shelter`, so
`ibusWeb.testing.playwright.setup`, for builds only, points `HOME` at a fresh
temporary directory. The other variables are `PLAYWRIGHT_BROWSERS_PATH`
(nixpkgs' `playwright-driver.browsers` without WebKit, ffmpeg or full
Chromium), `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` and
`PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1`. No `MOZ_*` variable is needed.

Each browser runs three hosts: every scenario with the host asleep in
`ibusweb_wait`, plus `pool-exhausted`; a host with WasmFS's OPFS backend
mounted at `/engines/spike`, which runs `cold-wake`, `promise-proxied-fsync`
(memory and OPFS), `opfs` and `opfs-read-only`; and the crash scenario on its
own host. The check runs the asserting runtime, then the released one, and
takes 49 s for both in both browsers (about 5 min before, with the
comparisons and 8 s spins). The comparisons (the page waiting asynchronously,
the idle host in `Atomics.waitAsync`, the relay-less `control` mode) moved out
of the checks into `nix run .#runtime-spike-compare`, which runs them under
Node and in both browsers from a checkout (112 s on this host).

### Threads beyond the pool

A browser starts a Worker only once the thread that created it is back in
its event loop (Chromium), or creates it only while the page's main thread is
free (Firefox; both shown under "Where the engines differ"). The host never
returns to its event loop, so it can't wait for a Worker beyond the pool.
Instead:

**The pool is sized for the planned peak, plus spares.**
`ibusWeb.runtime.threadPool` (`runtime/ibus-runtime/package.nix`) derives
`PTHREAD_POOL_SIZE` from shares and a low-water mark of spare Workers:

| Share | Threads | Kept | How it was counted |
| --- | --- | --- | --- |
| GLib | 3 | the first two for good, the third 15.5 s after its last task | `sync-proxied`, which now asserts it: after its GTask, 3 more Workers are busy than before, in Node and both browsers. This is the footprint of one GTask in flight, not GLib's maximum. GTask's first use starts GLib's worker-context thread (`g_task_thread_pool_init` attaches its pool manager to `g_get_worker_context()`, which starts `gmain`), the thread-pool spawner, and a worker the spawner starts, which waits 0.5 s in the GTask pool, then 15 s among unused threads. GTasks in flight at once start more workers: GTask's pool allows `G_TASK_POOL_SIZE` (10), and its pool manager raises that while every worker stays busy |
| OPFS backend | 1 | from mount, for good | 7 of 8 Workers idle with OPFS mounted, 8 of 8 without |
| Engine (the spike's side modules) | 4 | while they run | the largest burst a scenario starts, `spawn(4)`; an engine's share would come from its manifest |
| Planned | 8 | | glib 3 + storage 1 (measured with OPFS) + engine 4 |
| Spare (`lowWater`) | 3 | | GLib's share, below |
| Pool | **11** | | planned 8 + spare 3 |

Starting the runtime starts no thread (11 of 11 idle before any scenario).

**Exceeding it fails at once.** `-sPTHREAD_POOL_SIZE_STRICT=2` makes
Emscripten's `getNewWorker()` return nothing when the pool is empty, so
`pthread_create()` fails with `EAGAIN` instead of creating a Worker that
can't start; the asserting build also logs "the thread pool is exhausted".
Under Node (`ENVIRONMENT_MAY_BE_NODE`), Emscripten ignores the setting and
creates a Worker, which starts there anyway. What GLib (2.88) does with
`EAGAIN`, in the paths the runtime and the spike use:

- `g_system_thread_new()` turns `EAGAIN` into `G_THREAD_ERROR_AGAIN` and
  aborts on any other error. `g_thread_try_new()` returns `NULL` with that
  error; `g_thread_new()` aborts (`g_error("creating thread …")`).
- `g_get_worker_context()` starts `gmain` with `g_thread_new()`: the first
  GTask aborts the runtime if no Worker is idle.
- A non-exclusive `GThreadPool` starts its spawner with `g_thread_try_new()`
  and returns `NULL` if it fails; GTask asserts that its pool isn't `NULL`, so
  that aborts too.
- `g_thread_pool_push()` asks the spawner for a worker, which it creates with
  `g_thread_try_new()`. On failure the push returns `FALSE` but leaves the
  task queued, and GTask passes no `GError` and ignores the result. A worker
  the pool already has picks the task up once it is free; only if the pool
  has none does the GTask wait until a later push starts one, possibly for
  good.
- The spike's side modules use `g_thread_try_new()` where a scenario exceeds
  the pool, and report `-EAGAIN`; their `g_thread_new()` calls would abort.

`pool-exhausted` (browsers only) holds top-ups off, takes every idle Worker
with threads that wait (`hold`), and creates one more thread, from a pump and
then from another thread (proxied to the host): both fail with `EAGAIN`, in
0.5–1.0 ms and 4.1–4.3 ms, and the host goes on answering. It reads the idle
count once and relies on it holding: `sync-proxied`'s GTask worker lives some
15.5 s after its task, against about 0.1 s between the two scenarios. The
check marks the warnings these failures print (the spike's "Error creating
thread: Resource temporarily unavailable" and, asserting, Emscripten's "the
thread pool is exhausted") as expected.

**The host tops the pool up.** Whenever no request is pending and fewer than
`lowWater` Workers are idle, which happens only once more threads are alive
than the shares plan for, the host creates the missing Workers and waits
for requests with `Atomics.waitAsync` instead of `ibusweb_wait`, its event
loop running, until they have loaded; it serves requests meanwhile. It uses
Emscripten's own pool, which the runtime exports for it
(`-sEXPORTED_RUNTIME_METHODS=HEAPU8,PThread`): `PThread.allocateUnusedWorker()`
creates a Worker and `PThread.loadWasmModuleToWorker()` sends it the runtime
and settles once it reports `loaded`. Emscripten hands out any Worker in
`PThread.unusedWorkers`, loaded or not, so the host keeps a new Worker out of
it until it has loaded; otherwise a pump that created a thread right away
would block on a Worker that can't start. A top-up completes when the last
Worker has loaded; one that hasn't within 10 s is reported as a host error,
and the host stops topping up. The host refuses to start if the runtime
lacks `HEAPU8` or the `PThread` members it uses.

`lowWater` is GLib's share, 3: GLib's first GTask needs all three of its
threads at once, and every way GLib fails to get one is bad (above). The pool
starts with those 3 spares beyond the planned 8, so whenever the host is
idle at least 3 Workers are free: a thread an engine starts beyond its share
takes a spare, not one GLib counts on, and the host replaces it. Threads
within the shares never take a spare, so the pool grows only on an
overshoot. Once added, Workers stay.

The alternative was a pool of 8 whose top-up keeps 3 Workers idle beyond what
the shares still reserve (8 minus the threads alive). With 8 Workers that
reserve-adjusted count is 0 from the start, so the host would top up to 11
at its first idle moment anyway: the same Workers and memory, loaded after
"ready" instead of with the runtime, through a 47–60 ms top-up and, in
Firefox, a `new Worker()` window while the page may already be sending
keystrokes. Starting with 11 costs the 3 Workers' memory up front (about
18 MiB each in Chromium, 12–16 MiB in Firefox and 42 MiB under Node; What
a pool Worker costs, below) and 15–30 ms of startup
(one sandbox run each, released: Chromium 160–171 ms against 138–164 ms
with 8, Firefox 147–156 ms against 118–131 ms, Node 184 ms against 163 ms).
The way to save that memory is fewer spares, not a lazier top-up.

`pool-top-up` checks both halves in Node and both browsers: with 8 threads
alive (`hold`) and the host idle, 3 of 11 Workers stay idle and the host
creates no Worker, starts no top-up and makes no event-loop turn; with 9, it
tops the pool up by one Worker in 47–48 ms in the browsers and 74 ms in Node
(asserting: 78–83 ms, 118 ms), back to 3 idle. Against the earlier sizing (a
pool of 8, mark 3) it fails: the planned peak starts a top-up of 3.

Measured by `pool-exhausted` (released runtime): with every Worker taken,
allowing top-ups again adds 3 Workers in 54–60 ms in both browsers (asserting
runtime: 90–106 ms), of which the three `new Worker()` calls take 0.2 ms in
Chromium and 1.0 ms in Firefox. A burst of three threads on them then starts
and joins in 33–36 ms (Chromium) and 7.6–8.4 ms (Firefox), creating no Worker.
`thread-create-blocked` checks that a burst within the pool, `spawn(4)` from a
pump and `spawn-nested(3)` from a thread, never waits for an event loop: no
Worker is created and the host's event-loop turns don't move.

In Firefox the top-up has one window: `new Worker()` on the host returns only
once the page's main thread is free, so a request posted during those 1 ms
spins until the page lets go. Under D6 that is at most 40 ms and a replay;
`pool-top-up` hit it when it asked for stats right after the overshoot, and
now lets the page go free first. The top-up rests on Emscripten internals
(`PThread`), an upstream-trackable gap: a public call to grow the pool and
settle once the Workers can run threads. The host's whole JavaScript surface
of the runtime, `HEAPU8` and `PThread`, lies outside the export manifest,
which lists only WASM symbols.

### Results against Node

Released runtime, one sandbox run each. Node is the same run of
`checks.runtime-spike-node`. Browsers coarsen `performance.now()`: the
host's and the page's step is 5 µs in Chromium and 20 µs in Firefox
(cross-origin isolated), against 0.02 µs in Node, so a single round trip
reads as a multiple of the step. `dispatch` also times ten batches of 100
requests whole, between two readings, for a mean finer than the step.
`cold-wake` can't be batched (each request needs a gap with the host asleep,
which the same clock would time); each of its requests starts after a timer,
at no particular point of the step, so the mean of its 300 round trips is
finer than the step too. The ε and deadline numbers come from GLib's clock,
which reads the same coarsened clock.

| Scenario | Node | Chromium 149 | Firefox 151 |
| --- | --- | --- | --- |
| `dispatch` p50 / p99 / max; batch mean (range) | 9.8 / 39.8 / 303 µs; 11.6 µs (9.6–17.0) | 5 / 30 / 425 µs; 6.3 µs (5.4–10.4) | 20 / 40 / 380 µs; 10.0 µs (9.4–18.2) |
| `cold-wake` p50 / p99 / max; mean | 27.6 / 44.3 / 47.8 µs; 25.9 µs | 30 / 60 / 75 µs; 31.6 µs | 20 / 40 / 100 µs; 19.4 µs |
| `thread-create-blocked` | PASS: `spawn(4)` 71.9 ms, `spawn-nested(3)` 2.2 ms | PASS: 50.1 ms, 4.2 ms | PASS: 17.7 ms, 4.2 ms |
| `pool-top-up` (pool of 11) | PASS: no growth at 8 alive; top-up of 1 in 73.8 ms at 9 | PASS: the same; 47.3 ms | PASS: the same; 48.4 ms |
| `thread-exit-blocked` | PASS: 0.18 MiB every round, 0 Workers created | PASS: the same (2.2 MiB before, on a host that the failed `thread-create-blocked` had left with threads that never started) | PASS: the same |
| `cross-thread-wake` ε p50 / max | 0.050 / 0.091 ms | 0.035 / 0.085 ms | 0.061 / 0.120 ms |
| `deadline` worst deviation | 0.190 ms | 0.211 ms | 0.239 ms |
| `sync-proxied` | PASS: `proxy-sync` 557 µs, GTask 2294 µs, 3 Workers kept | PASS: 340 µs, 1491 µs, 3 | PASS: 419 µs, 2080 µs, 3 |
| `promise-proxied-fsync` | PASS: memory 2.1 ms, Node backend 6.4 ms | PASS: memory 4.1 ms; OPFS 4.4 ms | PASS: memory 4.2 ms; OPFS 8.6 ms |
| `exceptions`, `thread-crash` | PASS | PASS | PASS |
| `pool-exhausted` | (browsers only) | PASS: as above | PASS: as above |
| `opfs` (files opened `O_RDWR`) | (no OPFS) | PASS: write + `fsync` + close 0.73 ms, read back 0.38 ms | PASS: 5.5 ms, 2.1 ms |
| `opfs-read-only` | (no OPFS) | PASS: read back 0.63 ms | **FAIL (known):** the read's reply came only once the 1 s spin gave up, 0.7 ms after it |
| `cold-wake` with OPFS mounted | | 35 / 95 / 170 µs; 36.4 µs | 40 / 80 / 200 µs; 31.9 µs |

Calls that held the page's thread past D6's 40 ms: in Chromium, `spawn(4)`
(49.9 ms) and `pool-exhausted`'s burst of three on new Workers (49.5 ms); in
Firefox, only `opfs-read-only`'s read; under Node, `spawn(4)` (71.7 ms).
Every other call returned within 10.2 ms (a `yield` of 10 ms is the longest).
A pump that starts threads on Workers that have never run one is the slow
case in Chromium: each first thread costs about 12 ms there, against 2–5 ms
in Firefox.

The asserting runtime passes the same scenarios with the same one known
failure.

Comparisons (released runtime, one run of `nix run .#runtime-spike-compare`
on this host outside the sandbox; the runs above in the same invocation gave
cold-wake means of 41.0 µs in Chromium and 37.6 µs in Firefox):

| | Chromium | Firefox |
| --- | --- | --- |
| Page waits asynchronously: `cold-wake` p50 / p99, mean | 40 / 70 µs, 39.7 µs | 40 / 140 µs, 57.5 µs |
| Page waits asynchronously: every scenario | PASS | PASS, `opfs-read-only` included (read back 0.5 ms) |
| Idle host in `Atomics.waitAsync`: `cold-wake` p50 / p99, mean | 35 / 65 µs, 35.4 µs | 40 / 100 µs, 40.1 µs |
| Idle host in `Atomics.waitAsync`: every scenario | PASS | PASS |
| Relay-less (`control`): `cold-wake` p50 / p99, mean | 20 / 45 µs, 20.6 µs | 20 / 80 µs, 20.5 µs |
| Relay-less (`control`): `dispatch` batch mean | 5.9 µs (option 2: 7.0 µs) | 9.0 µs (option 2: 10.4 µs) |
| Relay-less (`control`): `sync-proxied` | FAIL: pending, as under Node | FAIL: pending, as under Node |

At the p50 and p99, option 2 and the relay-less mode are indistinguishable
at one or two clock steps. The means separate them: in that run a cold wake
through the relay and the runtime's sleep cost 37.6–41.0 µs against
20.5–20.6 µs relay-less, 17–20 µs more, where the same invocation under
Node measured 14.9 against 14.0 µs. Back to back (`dispatch`) the difference
is 1.1–1.4 µs. Means vary between runs: the sandbox run above measured
cold-wake means of 31.6 µs (Chromium) and 19.4 µs (Firefox) through the
relay. In browsers, then, the relay and the in-runtime sleep add up to about
20 µs to a keystroke that finds the host asleep, against a 40 ms budget.

### Where the engines differ

Evidence from the runs above, and from `nix run .#runtime-spike-experiments`
(`src/node/experiments.ts`, `src/page/experiments.ts`,
`src/worker/experiment.ts`), which measures without the runtime. In its
nested-Worker experiment, Worker A starts Worker B; on "go", A creates Worker
C and then blocks in `Atomics.wait` for 3 s, while B, a child of A, runs OPFS
calls and creates Worker D. Each Worker marks its steps in a shared buffer,
once with the page's main thread free and once with it spinning for 3 s
(ms after go, one run on this host):

| Step | Chromium, page free | Chromium, page spins | Firefox, page free | Firefox, page spins |
| --- | --- | --- | --- | --- |
| A: `new Worker(C)` returns | 0 | 0 | 0 | **3001** |
| C starts | **3004** | **3004** | 13 | 3009 |
| A unblocks (it blocks for 3000 ms once `new Worker(C)` returns) | 3000 | 3000 | 3000 | 6001 |
| B: `getDirectory()`, `getFileHandle()` (present, absent) | 0–1 | 0 | 0 | 0 |
| B: sync access handle created, written, flushed, closed | 1 | 1 | 3 | 2 |
| B: `getFile()` | 1 | 1 | 4 | 3 |
| B: `File.arrayBuffer()` | 1 | 1 | 4 | **3001** |
| B: `new Worker(D)` returns | 2 | 1 | 4 | **3003** |
| D starts | 5 | 4 | 14 | 3009 |

- **Chromium starts a Worker only once the thread that created it returns to
  its event loop** (C at 3004 ms). A thread beyond the pool would never start
  under a host that never returns to its event loop; with the pool sized for
  the peak and topped up while idle, none is needed.
- **Firefox starts such a Worker while its creator is blocked, but
  `new Worker()` on a Worker returns only once the page's main thread is
  free** (3001 ms with the page spinning). The top-up calls `new Worker()`
  only when no request is pending.
- **Firefox reads a file's Blob only with the page's main thread free**
  (`File.arrayBuffer()` at 3001 ms). Sync access handles, `getDirectory()`,
  `getFileHandle()` and `getFile()` itself don't wait for it. Chromium's OPFS
  doesn't depend on the page at all. See "OPFS" below.
- **Sync access handles:** both browsers have them; only Chromium knows the
  `mode` option (below).
- **`Atomics.wait` in module Workers, `Atomics.waitAsync`:** present in both
  (the host reports `atomicsWaitAsync` and `syncAccessHandle` true, and the
  relay sleeps in `Atomics.wait`). The relay, a nested module Worker, starts
  in both.
- **Nested Workers:** pthreads are module Workers created from the host
  Worker by `new URL("ibus-runtime.js", import.meta.url)`. The pool starts at
  startup in both (host startup 120–160 ms with the released runtime).
- **Timer resolution:** 5 µs (Chromium) and 20 µs (Firefox), in the page and
  in the host, cross-origin isolated.
- **A crash** reaches the host as the pthread Worker's `ErrorEvent`, which
  Emscripten rethrows (Node: an `Error`). The host describes it by its
  message and source, and both browsers report the trapping thread's error.
- **Firefox warns** for every runtime instance: "The WebAssembly exception
  handling 'try' instruction is deprecated ... recompile to use the
  'try_table' instruction". `-fwasm-exceptions` emits the legacy encoding.
  Emscripten's `-sWASM_LEGACY_EXCEPTIONS=0` emits the standard one (exnref,
  `try_table`); it is a compile and link setting, so every object and the
  cache's libraries would be rebuilt with it. Support (MDN's compatibility
  data, `exceptionsFinal`): Chrome 137, Firefox 131, Safari 18.4, so
  Baseline 2025, newly available since Chrome 137 (May 2025) and widely
  available only from about November 2027. Node v24.20 (V8 13.6) validates
  `try_table` without a flag. Every browser above still runs the legacy
  encoding. Not changed here: switching is a spec follow-up.
- `proxy-sync` took 1–3 ms in Firefox in the first runs; now 0.4 ms, as in
  Chromium (not investigated either way).

### OPFS

On WasmFS's OPFS backend mounted at `/engines/spike`, both browsers do the
following. A file is absent at first (fresh storage; `-ENOENT`). It is
written, `fsync()`ed and closed on the host's thread, read back through the
runtime, and reads the same through the page's own OPFS API. The file
`promise-proxied-fsync` wrote from a pthread (which proxies to the backend's
own thread) reads back the same way; `opfs` reports that leg as "not run"
when `promise-proxied-fsync` didn't run first. `promise-proxied-fsync` on OPFS
completes while the host sleeps: 4.4 ms in Chromium, 8.6–21 ms in Firefox
(the poll's resolution is 2 ms). The backend's thread is notified directly,
not through the host, because both browsers have `Atomics.waitAsync`.
Without it Emscripten would route the notification through the sleeping
host, and only the backend's 50 ms heartbeat would recover it.

**How WasmFS reads.** In Emscripten 6.0.9 (`system/lib/wasmfs/backends/opfs_backend.cpp`,
`src/lib/libwasmfs_opfs.js`), a file's first open decides how all its open
descriptors in that runtime reach it:

- `O_WRONLY` or `O_RDWR`: `createSyncAccessHandle()`, with no options. (The
  library passes `{mode: 'in-place'}`, a shape from an early Chromium trial,
  only if the method declares a parameter; neither browser's does.) Reads are
  `accessHandle.read()`, synchronous, on the backend's thread.
- `O_RDONLY`: `getFile()` once, then `blob.slice().arrayBuffer()` for each
  read, asynchronous, on the backend's thread. A file already open for
  writing is read through its handle; a read-only file opened for writing
  later moves to a handle.
- Either open fails with `EACCES` when the browser refuses for a lock
  (`InvalidStateError`, `NoModificationAllowedError`).

**Prototype: open for reading and writing.** No Emscripten change is needed
to read through a sync access handle: open the file `O_RDWR`. The `opfs`
scenario now reads that way (`read-file-rdwr`) and passes in Firefox with the
page spinning: open, read and close in 2.1 ms (Chromium 0.38 ms).
`opfs-read-only` reads the same kind of file opened `O_RDONLY`, through its
Blob: 0.6 ms in Chromium; in Firefox it waits for the page, and stays a known
failure, matched on that cause (it would pass but for late replies, all of
them to `read-file`). With the page waiting asynchronously it passes (0.5 ms).

**What it costs: locks.** The experiments page's lock table (one run on this
host; Y and X are Workers of one page, Z a Worker of another page of the same
origin):

| Case, on one file | Chromium 149 | Firefox 151 |
| --- | --- | --- |
| X holds a handle with no mode or `readwrite`; Y opens one in any mode, or X again or Z with no mode | `NoModificationAllowedError` | `NoModificationAllowedError` |
| X holds `read-only`; Y, X again, or Z opens `read-only` | ok | `NoModificationAllowedError` |
| X holds `readwrite-unsafe`; Y opens `readwrite-unsafe` | ok | `NoModificationAllowedError` |
| `read-only` against `readwrite-unsafe`, either way | `NoModificationAllowedError` | `NoModificationAllowedError` |
| Y reads the file as a Blob while X holds a handle, any mode | ok | ok |
| Y opens a writable stream while X holds a handle, any mode | `NoModificationAllowedError` | `NoModificationAllowedError` |
| X writes through a handle it opened `read-only` | `NoModificationAllowedError` | writes: the mode is ignored |

The WHATWG File System standard has no `mode`: a sync access handle takes an
exclusive lock on its file. Chromium's modes (`read-only` and
`readwrite-unsafe` share among themselves) are its own, from Chrome 121; MDN
lists none for Firefox or Safari, and Firefox silently takes an exclusive,
writable handle when asked for `read-only`. So:

- Read through a handle (`O_RDWR` on our side), a file can be open in one
  runtime at a time, across every Worker and tab of the origin, in every
  engine: a second engine Worker, or the same engine in a second tab, gets
  `EACCES` until the first closes it.
- A small upstream change, `O_RDONLY` opening `createSyncAccessHandle({mode:
  "read-only"})` and falling back to the Blob, would share read-only handles
  in Chromium only. In Firefox (and by the standard, Safari) it would turn
  every read-only open into an exclusive, writable lock, and no feature test
  tells the two apart short of trying a write. Not a safe default upstream;
  at most an opt-in.
- Blob reads take no lock: any number of runtimes read a file at once, even
  while one holds a handle on it. Only Firefox's dependence on the page's
  main thread speaks against them.

**Recommendation:** read engine data, which every tab running the engine
shares and nobody writes, through the Blob path (`O_RDONLY`), and keep those
reads off the keystroke path: read it when the engine loads, while the page
isn't spinning, rather than lazily per keystroke. In Firefox a Blob read
that does land in a keystroke costs a replay (D6), not a hang. Use sync
access handles (`O_RDWR`) for files one runtime owns and writes, such as a
user's learning data, where an exclusive lock is what's wanted. **Decision
for the user:** whether an engine may read its data from OPFS lazily during
keystrokes. If it may, Firefox forces a choice between a replay on every
such read and exclusive locks that keep a second tab or engine instance from
opening the same data; either constrains the spec's engine-data loading.
The question went to IndexedDB, below, and was decided there.

### IndexedDB and Cache Storage under the spin

Does any store let a Worker read engine data during a keystroke in Firefox
without a lock? `nix run .#runtime-spike-storage` (`src/node/storage.ts`,
`src/worker/storage.ts`, the page's `timed`) measures it without the runtime,
in the browsers above. Each run gets a fresh browser context; Worker X fills
the store with 4 MiB of random bytes with the page free, then the page sends
one command and either stays free or spins for 200 ms (five times D6's
40 ms) while X runs it. X marks each step in ms after the command was sent;
reads are awaited one at a time, as a backend serving lazy reads would.
The tables give the last step, min–max over three runs, and whether it
ended before the spin did.

Chromium 149:

| Operation | Page free | Page spins | Ends during the spin |
| --- | --- | --- | --- |
| IndexedDB, ArrayBuffer values: open, read 64 × 64 KiB in one readonly transaction | 12.8–13.8 | 12.0–15.4 | yes, 3/3 |
| The same, the connection already open | 11.5–12.6 | 11.8–16.8 | yes, 3/3 |
| IndexedDB, already open: one 4 MiB ArrayBuffer value | 3.2–3.9 | 2.6–3.3 | yes, 3/3 |
| IndexedDB, already open: write 64 × 64 KiB in one readwrite transaction, to commit | 12.7–15.8 | 14.8–15.8 | yes, 3/3 |
| IndexedDB, Blob values: 64 gets in one transaction, then each Blob's `arrayBuffer()` | 9.8–11.0 | 9.2–12.6 | yes, 3/3 |
| Cache Storage: `caches.open()`, then 64 × `match()` and `Response.arrayBuffer()` | 11.4–14.9 | 14.1–15.5 | yes, 3/3 |
| OPFS, Blob: `getFile()`, then 64 slices' `arrayBuffer()` | 12.9–15.1 | 13.7–14.4 | yes, 3/3 |
| OPFS, sync access handle: open, 64 reads, close | 5.0–6.7 | 4.8–5.7 | yes, 3/3 |

Firefox 151:

| Operation | Page free | Page spins | Ends during the spin |
| --- | --- | --- | --- |
| IndexedDB, ArrayBuffer values: open, read 64 × 64 KiB in one readonly transaction | 12.4–14.1 | 12.5–25.4 | yes, 3/3 |
| The same, the connection already open | 12.2–13.3 | 12.8–14.2 | yes, 3/3 |
| IndexedDB, already open: one 4 MiB ArrayBuffer value | 10.3–12.2 | 10.2–10.9 | yes, 3/3 |
| IndexedDB, already open: write 64 × 64 KiB in one readwrite transaction, to commit | 23.0–24.7 | 23.4–24.6 | yes, 3/3 |
| IndexedDB, Blob values: 64 gets in one transaction, then each Blob's `arrayBuffer()` | 9.1–12.8 | **206.5–207.9** | **no, 0/3**: the gets and the commit end at 4.2–5.0 ms, the first `arrayBuffer()` at 200.7–200.8 |
| Cache Storage: `caches.open()`, then 64 × `match()` and `Response.arrayBuffer()` | 19.3–24.3 | **220.9–226.9** | **no, 0/3**: `open()` and the first `match()` by 1.4 ms, the first `arrayBuffer()` at 200.9–201.1 |
| OPFS, Blob: `getFile()`, then 64 slices' `arrayBuffer()` | 7.1–8.5 | **207.3–209.2** | **no, 0/3**: `getFile()` at 0.7–0.8 ms, the first slice at 200.6–200.8 |
| OPFS, sync access handle: open, 64 reads, close | 4.2–22.1 | 3.6–3.8 | yes, 3/3 |

In Firefox the wait follows the Blob, not the store: whatever hands the
Worker a Blob or a response body to read (an OPFS `File`, a Blob-valued
IndexedDB record, a cached `Response`) reads its bytes only once the page's
main thread is free; the run's later reads then take their usual time. IndexedDB values that are ArrayBuffers come back with the `get()`
itself and never wait, nor does a 4 MiB value, `indexedDB.open()`, or a
write and its commit. (Why Firefox routes Blob reads through the page's
thread wasn't investigated.) In Firefox one cold run's `indexedDB.open()`
took 11.4 ms with the page spinning, against 1.2–1.7 ms otherwise; still
well inside the spin. Chromium never waits for the page.

**Concurrency** (one run per browser; X and Y are Workers of one page, Z a
Worker of a second page of the same origin; ms are each read's last step):

| Case | Chromium 149 | Firefox 151 |
| --- | --- | --- |
| X and Y each read the 64 chunks at once | ok, 19.5 ms; ok, 16.4 ms | ok, 14.3 ms; ok, 14.3 ms |
| The same, the page spinning 200 ms | ok, 14.8; ok, 19.0 | ok, 14.5; ok, 14.4 |
| X (page 1) and Z (page 2), each with a connection held open since before, read at once | ok, 16.1; ok, 16.6 | ok, 14.3; ok, 14.0 |
| Y reads the 64 chunks while X rewrites them in one readwrite transaction (X; Y) | ok, 15.2; ok, 28.3 | ok, 21.6; ok, 28.5 |
| Z opens the database at version 2 while X holds a connection, which X closes 300 ms later | X gets `versionchange`; Z `blocked`, then opens at 299 ms | X gets `versionchange`; Z `blocked`, then opens at 305 ms |
| Cache Storage: X and Y read the 64 responses at once | ok, 18.6; ok, 19.0 | ok, 20.3; ok, 20.0 |
| OPFS: Y opens a sync access handle while X holds one | `NoModificationAllowedError` | `NoModificationAllowedError` |

IndexedDB never refuses a reader: readonly transactions run side by side
across Workers and pages, and a readonly transaction over a store that a
readwrite one holds waits for its commit rather than failing. The one
exclusive operation is a version change (needed only to add or remove object
stores): it stays `blocked` until every other connection closes, so a
holder must close on `versionchange` or an upgrade in another tab waits for
good. Replacing data inside a version needs no upgrade.

**Random reads, page free** (µs per read, median / 95th percentile / mean of
256, one run; reads at random among 1024 4 KiB values or 64 64 KiB values,
or at size-aligned offsets into a 4 MiB OPFS file; Firefox's clock steps by
20 µs, so its sub-20 µs medians are its resolution and the means are the
figures to compare):

| Read | Chromium 149 | Firefox 151 |
| --- | --- | --- |
| IndexedDB, 4 KiB, a readonly transaction per read | 40 / 65 / 42 | 60 / 100 / 58 |
| IndexedDB, 4 KiB, all 256 in one readonly transaction | 20 / 45 / 27 | 40 / 60 / 44 |
| OPFS, 4 KiB, sync access handle `read()` | 45 / 60 / 44 | 20 / 20 / 15 |
| OPFS, 4 KiB, Blob slice `arrayBuffer()` | 125 / 150 / 126 | 60 / 80 / 58 |
| IndexedDB, 64 KiB, a readonly transaction per read | 175 / 325 / 194 | 200 / 620 / 300 |
| IndexedDB, 64 KiB, all 256 in one readonly transaction | 145 / 245 / 157 | 180 / 240 / 193 |
| OPFS, 64 KiB, sync access handle `read()` | 50 / 85 / 56 | 0 / 20 / 8 |
| OPFS, 64 KiB, Blob slice `arrayBuffer()` | 200 / 245 / 196 | 80 / 160 / 109 |

A random 4 KiB read from IndexedDB costs 20–60 µs, about a sync access
handle's in Chromium and three to four times its cost in Firefox; at 64 KiB
IndexedDB costs 150–300 µs against a handle's 8–56 µs. These are reads in
the Worker itself. IndexedDB is asynchronous, so a WasmFS backend on it would
serve each read on a backend thread and block the caller until it is done,
as the OPFS backend's Blob path does; that round trip isn't measured here.
Emscripten 6.0.9's WasmFS has no IndexedDB backend (its backends are memory,
Node, OPFS, fetch, JS file and ignore-case), so it would be ours to write and
keep.

**Evidence for the decision** (decided: the second, under "Conclusions for
the design"):

- *Load engine data into memory at engine start.* Works in both browsers from
  any store, the Blob paths included, since engine start isn't under the
  spin; no lock, so every tab and engine instance can load the same data.
  4 MiB reads in 3–25 ms from IndexedDB or OPFS here. The cost is a copy in
  every runtime instance's memory (the fixed 32 MiB of the spike's build) and
  in the engine's start-up time.
- *An IndexedDB-backed WasmFS backend for lazy reads.* The evidence favours
  it on both counts that rule out OPFS in Firefox: ArrayBuffer-valued reads
  complete during the spin, and nothing takes an exclusive lock, so a second
  tab or engine instance reads the same data. Conditions: values must stay
  ArrayBuffers (a Blob value reintroduces the wait); the backend is new code
  outside Emscripten; each read pays IndexedDB's 20–60 µs (4 KiB) plus the
  proxying round trip; the data must be written into IndexedDB at install;
  and schema upgrades need connections that close on `versionchange`.
- *Accept D6 replays.* Keep OPFS's Blob path for lazy reads: no lock, and
  Chromium never waits. In Firefox every keystroke whose read reaches a Blob
  that the runtime hasn't read before would spin the full 40 ms and replay:
  the read waits for the page, not for its bytes, so the cost is per
  keystroke that reads, however little.

## Memory growth

GLib's tests, linked with memory growth, lost a pthread now and then to
`RuntimeError: memory access out of bounds` (13 of 300 runs of the
many-thread tests under load) and never did with a fixed memory. This part
finds out why, and whether the runtime can grow its memory.
`nix run .#runtime-spike-memory` runs all of it (parts `growrace`,
`emufutex`, `node`, `browsers`; counts from `RUNS`, `BROWSER_RUNS`,
`PARALLEL`, `EMUFUTEX_PARALLEL` and `GROWRACE_RUNS`). Node 24.19.0 (V8
13.6.233.17), Chromium 149 and Firefox 151 (Playwright's builds), Bun 1.3.13;
32 cores, shared with other work.

### Root cause: V8 bounds-checks atomics against a stale length

`growrace` (`tests/spikes/memory/`) needs neither Emscripten nor GLib: the
page grows a shared memory a page at a time and, after each growth,
`Atomics.store`s the new page's last word's address at address 0; sixteen
Workers spin in WebAssembly on an atomic load of address 0 and increment
each new address they see. A reader only touches memory a sequentially
consistent load told it was grown, so none should trap. Races in which one
did, of 20 per cell, 8192 growths each:

| Engine | plain load and store | atomic RMW | atomic RMW in a callee | atomic RMW after a JS call | atomic RMW, never grown |
| --- | --- | --- | --- | --- | --- |
| Node, default | 0 | **20** (42 readers) | 0 | 0 | 0 |
| Node, `--liftoff --no-wasm-tier-up` | 0 | **20** (34 readers) | 0 | 0 | 0 |
| Node, `--no-liftoff` | 0 | 0 | 0 | 0 | 0 |
| Chromium 149 | 0 | **20** (29 readers) | 0 | 0 | 0 |
| Firefox 151 | 0 | 0 | 0 | 0 | 0 |
| Bun 1.3.13 (JavaScriptCore) | 0 | 0 | 0 | 0 | 0 |

The same race in C through Emscripten's pthreads (`growrace.c`) trapped in
5 of 5 runs under Node. Only V8 traps, only on atomic accesses, only in
Liftoff code, and only when the access follows the load with no call
between them. A call is a stack check, where V8 handles interrupts, and V8
told other threads about a growth through an interrupt: each instance kept
its own copy of a shared memory's length for bounds checks, which a plain
access doesn't need (it relies on the guard region) and an atomic one does.
V8 knows: issues 529880019 and 533026477, fixed on V8's main branch by CLs
8466625 (bounds checks on shared memory read the backing store's length)
and 8480479 (growth orders that length `seq_cst`), merged 2026-09-29 and
-30. Both are in V8 15.7, so Chrome 157 (stable 2026-11-03); no Node release
line has them (Node 24: V8 13.6, 25: 14.1, 26: 14.6). Details in
`docs/upstream/v8-liftoff-atomics-grown-shared-memory.md`.

### The workloads, growing and fixed

Each run is a Worker host of its own with 100 threads alive at once on a
pool of 103 (no top-up during a run): *mem-stress*, without GLib's code,
threads that each round keep one more block of fresh memory, hand one to a
neighbour that increments a word of it atomically, and have JavaScript fill
another; *glib-stress*, GLib's `1bit-emufutex` workload (threads from
`g_rand_new()` taking random bit locks over the emulated futex). *Growth* is
the runtime linked with `-sGROWABLE_ARRAYBUFFERS=1`, its memory made at the
32 MiB minimum with a 2 GiB maximum; *growable* the same with `=2`; *fixed*
a 512 MiB memory whose maximum is its size. Node ran 6 runs at once,
browsers 2 pages at once. Runs in which a thread trapped:

| Configuration | Node (of 300) | Chromium (of 50) | Firefox (of 50) |
| --- | --- | --- | --- |
| fixed, mem-stress | 0 | 0 | 0 |
| fixed, glib-stress | 0 | 0 | 0 |
| growth, mem-stress | **3** | 0 | 0 |
| growth, glib-stress | 0 | 0 | 0 |
| growable (`=2`), mem-stress | not run (Node 24 lacks it) | 0 | no result |
| growable (`=2`), glib-stress | not run | 0 | no result |

GLib's own `1bit-emufutex` test, rebuilt from today's GLib tests with only
its memory flags changed, 32 copies at once under Node: with growth
(`-sALLOW_MEMORY_GROWTH=1 -sGROWABLE_ARRAYBUFFERS=1`) a thread trapped in
**15 of 300** runs, 11 of them at one site; fixed at 104 MiB, 0 of 300.
The same build with function names (`--profiling-funcs`) trapped in 9 of
another 300 runs, all at one `i32.atomic.rmw.add`: a libc++ `shared_ptr`
reference count in WasmFS's `OpenFileState::create`, under the `open()` of
`/dev/urandom` that `g_rand_new()` makes as each thread starts.
All three Node traps in mem-stress were at one instruction, the
`i32.atomic.rmw.add` by which a thread increments a word of a block its
neighbour had just allocated. The browsers' workloads didn't trap in 50 runs,
but Chromium's V8 has the same bug (growrace traps there every time): fewer
runs, two at a time, give the race fewer chances. Firefox 151's `=2` build
never produced a result (stopped after 4 runs of 240 s), as expected of a
Firefox before 154, where a growable shared buffer doesn't survive
`postMessage` to a pthread's Worker (not traced further). In an earlier
batch Firefox's browser process went away once during growth, glib-stress
(not reproduced; this batch's 50 such runs passed).

### What growth and its polling cost

One `memory-costs` run per build: the first 64 MiB allocation, which a
32 MiB memory must grow for, then the same again, and 10,000 calls into
JavaScript that write 64 bytes into the memory (`getentropy`), which a build
that polls for growth checks its views for first. Here *fixed* is the link
with growth support given a fixed 512 MiB memory, and *unpolled* a fixed
512 MiB link without growth support, for comparison (the runtime is now
linked as *unpolled* was).

| | Chromium | Firefox | Node (loaded machine) |
| --- | --- | --- | --- |
| first 64 MiB malloc: fixed / growth | 15 µs / 240 µs | 20 µs / 3.4 ms | 26 µs / 443 µs |
| touching it, any build | 9.9–13.0 ms | 8.6–8.8 ms | 11–27 ms |
| `getentropy` call: fixed / growth / `=2` / unpolled | 880 / 1049 / 1041 / 911 ns | 732 / 710 / no result / 704 ns | 2980 / 2581 / not run / 1231 ns |
| dispatch p50: fixed / growth / `=2` / unpolled | 15 / 15 / 10 / 15 µs | 20 / 20 / no result / 20 µs | 10.5 / 11.9 / not run / 6.9 µs |

Growth costs once per growth, 0.2–0.4 ms in V8 and 3.4 ms in Firefox for
64 MiB; polling (Firefox's and Node's `=1` path) costs nothing measurable
per call next to run-to-run noise. Node's figures come from a machine busy
with other work and vary by 2× between batches.

### What a pool Worker costs

`worker-memory` adds 20 Workers to a fixed-memory host's pool, each loading
the runtime, then runs a first thread on each, which loads the side modules
into it; two batches, the spike's and the check's. Growth of the browser's
processes (proportional set size, from `/proc`) or of Node's process
(resident set), per Worker:

| | Chromium | Firefox | Node |
| --- | --- | --- | --- |
| per added pool Worker | 17.8–17.9 MiB | 11.7–15.6 MiB | 41.4–41.8 MiB |
| per Worker's first thread | 4.4–4.7 MiB | 2.8–3.1 MiB | 9.7–9.8 MiB |

The spike's pool of 11 Workers costs about 200 MiB in Chromium and up to
170 MiB in Firefox, 250 and 200 MiB once each has run a thread, on top of
the runtime's memory.

### Decision

The approved rule was growth with `-sGROWABLE_ARRAYBUFFERS=1` unless growth
traps in some engine. It traps in V8, and no Node line has the fix, so **each
runtime's memory is fixed**, made by the host:

- The runtime is linked without growth (`-sALLOW_MEMORY_GROWTH=0`), so
  nothing in it can grow its memory, and imports its memory
  (`wasmMemory`); it refuses to start without one. Its import is declared
  with a maximum of 2 GiB (`-sIMPORTED_MEMORY -sMAXIMUM_MEMORY=2GB`, which
  Emscripten otherwise lowers to the initial size without growth; the
  toolchain carries a patch for it), and the runtime takes any size
  from `ibusWeb.runtime.memory.minimum` (32 MiB) to 2 GiB, whatever
  maximum the memory has. A full heap aborts (`-sABORTING_MALLOC=1`), even
  for `g_try_malloc()`. `checks.ibus-runtime-load` asserts the refusal,
  the bounds, and that a memory with room to grow is never grown. Without
  growth support Emscripten's JavaScript doesn't check its views before
  each access, as the *unpolled* build above didn't; that build is now
  the *fixed* one.
- The size is the engine manifest's `memory` field (spec §5.3, §8), not a
  link per engine, so one compiled runtime serves every engine. The Worker
  host checks it is whole pages within the runtime's bounds, failing the
  load otherwise, and makes `new WebAssembly.Memory({ initial, maximum:
  initial, shared: true })` from it. `checks.runtime-spike-node` asserts
  the refusals and that a full heap reaches the host as a crash.
- `ibusWeb.runtime.link { pname, extraFlags }` links the runtime with other
  flags; the spike's growth builds use it.
- `checks.runtime-spike-memory` runs both workloads on the packaged
  runtime with the threads its pool is planned for (8, on its pool of
  11), in a fixed 84 MiB, under Node and in both browsers, one run at a
  time, and fails on any trap or abort, telling Emscripten's
  out-of-memory abort apart from a trap. 84 MiB is memory-costs' 64 MiB
  allocation on a 2.5 MiB heap, a quarter more and rounded up; the
  workloads' heaps peaked at 18.9 MiB (40 Node runs), 16.8 MiB (30
  Chromium runs) and 19.5 MiB (30 Firefox runs). Its peak memory is
  some 1.6 GiB, and it takes some 11 s. The 100-thread runs, which
  reproduced growth's traps and needed some 5.9 GiB for the pool's 103
  Workers under Node, stay in `nix run .#runtime-spike-memory`.

## Emscripten's minimum versions

Every link now passes `-sMIN_{CHROME,FIREFOX,SAFARI,NODE}_VERSION`, derived
rather than left at Emscripten's defaults (Chrome 85, Firefox 79, Safari 15,
Node 18.3). The browsers are what baseline-browser-mapping 2.11.27 gives for
Baseline Widely available on its data's date, 2026-10-01: Chrome 123,
Firefox 124, Safari 17.4 (`170400`). Node is the workspace's, 24.19.0
(`241900`). Version 2.11.0's data (2026-07-08) gives Safari 17.2, below
extended-const's 17.4; with `-mextended-const` given, Emscripten enables the
feature anyway, without a warning, so `checks.toolchain-cache` links without
the flag and requires that the minimums alone turn it on.

What the minimums turn on in Emscripten's feature matrix: extended-const
(Chrome 114, Firefox 112, Safari 17.4). What they leave off: growable
`SharedArrayBuffer`s (`GROWABLE_ARRAYBUFFERS=2` needs Chrome 144, Firefox 145,
Safari 26.2, Node 26) and exnref Wasm exceptions (Chrome 137, Safari 18.4;
`WASM_LEGACY_EXCEPTIONS` is a setting of its own, not chosen by the matrix,
and stays on). Memory64 stays off (Safari has none).

The effect is nil on the WebAssembly and small on the JavaScript.
`ibus-runtime.wasm` (release) is 4,113,037 bytes before and after, differing
only in the GLib store path it embeds; the seven spike side modules are byte
for byte the same. extended-const replaces code that relocates internal GOT
globals with constant initialisers, and these modules have none: the main
module's data sits at fixed addresses, and side modules, linked with default
visibility, import every data address as a `GOT.mem` global, so their
`__wasm_apply_data_relocs` (stores of addresses into data) stays as it was.
`ibus-runtime.js` shrinks by 579 bytes (121 gzipped): fullscreen fallbacks
for old WebKit go, and random bytes come from `crypto.getRandomValues` under
Node too. Startup is unchanged within the runs' noise.

## The IndexedDB backend: one writer, and what it costs (M0.5)

The host mounts the engine's own files at `/engines/<name>/` on our WasmFS
IndexedDB backend, over the database `ibus-web/<name>`, and each version's
data, sealed read-only once installed, over a database of its own. This part
covers who may write the first, and what the backend costs.

### One writer per engine's user data

Every tab or Worker running an engine mounts the same user-data database.
IndexedDB serializes transactions but not files: two writers would interleave
writes to one file, and each writer's backend sweeps the database at mount of
the inodes no directory holds, which are another writer's files unlinked
while open. So one host writes and the others read:

- Before it creates the user-data backend, the host requests
  `ibus-web:writer:<name>` (the name encoded as in the other locks) with
  `ifAvailable`. Granted, it holds the lock for the Worker's life and mounts
  read-write; refused, it mounts with `WASMFS_IDB_READ_ONLY`, which also
  skips the sweep, and posts `storage: read-only` to the page. Hosts don't
  queue for it: a backend can't become writable, so a host that started
  read-only stays so, and the page restarts it to get a writer.
- A host whose start fails, or whose runtime crashes, lets go of the writer
  lock with its others. The memory fallback is the host's alone and takes no
  lock. Engine data needs none: it is read-only to every host.
- Under Node the host takes the lock and reports the same, but the Node
  backend has no read-only mode, so nothing refuses the reader's writes; Web
  Locks there coordinate the threads of one process only.

`writer-lock` (an install scenario: an engine of its own, hosts from one page
sharing the origin's storage and locks, or under Node one directory) starts
two hosts at once: exactly one reports no `storage: read-only` and writes,
the other's write fails with `EROFS` (IndexedDB) and it reads the file the
writer wrote, through its own backend. Once the writer's Worker is
terminated, a host started next takes the lock and writes; the reader stays
read-only. It failed under Node and in both browsers before the lock (both
hosts wrote, both swept), and passes in all three since.

**A terminated Worker's locks.** Chromium lets go of the locks of a Worker
terminated while it sleeps in `Atomics.wait()`, as the host does between
requests, only some 2 s after `terminate()`: 2.0 s in two runs of the page
polling with `ifAvailable`. A host idling in `Atomics.waitAsync()` instead,
its event loop running, lets go at once (its successor was ready 0.22 s
after the terminate). Firefox lets go at once, and Node once
`terminate()`'s promise settles. A host started within those 2 s
would find the lock taken and stay read-only for good. So the page, having
terminated a host that didn't report `storage: read-only`, waits for that
engine's writer lock to come free, with a queued request it lets go of at
once (bounded at 10 s, after which another tab holds it), before starting the
engine's next host; `writer-lock`'s next host is ready 2.2 s after the
terminate in Chromium (four runs), 0.26–0.27 s in Firefox. A host that dies
without the page terminating it (its renderer out of memory, its Worker
crashing) gets no such wait. Node grants a queued request for a terminated
thread's lock only once another request arrives (above, under the install
lock); no waiting is needed there, since `ifAvailable` sees the lock free.

**The page must keep out of the engine's databases.** A transaction the page
opens on an engine's database and hasn't seen commit when it starts to spin
holds up the backend's writes to the same object store until the spin ends:
a page that read the user-data database's `meta` store just before a request
got its reply only once its 1 s spin gave up (both browsers), since the
transaction's commit runs on the page's thread. Waiting for the
transaction's `complete` before the request removes it. The harness reads
the chunk size that way; the real page has no reason to open the engine's
databases at all (§9.2).

### What it costs

`storage-costs` works an engine-like dictionary file in the engine's
directory: 4,200 KiB (4 MiB and 104 KiB, so that it ends 8, 40 and 104 KiB
into a chunk of 16, 64 and 256 KiB), written in 64 KiB `write()`s and
`fsync()`ed, then read at random, 4 KiB and 64 KiB aligned reads, then
appended to in 100 64-byte records, each `fsync()`ed. Every byte is a
function of its offset that looks random (so no store compresses it), and
every read is checked: the scenario passes on correctness alone. Each call is
made on the host's thread from the `bench` side module, so it blocks for the
proxied round trip to the backend's thread and its IndexedDB transaction, and
is timed there with `emscripten_get_now()`; single reads are also requested
one at a time from the page, the file kept open, and timed there, request,
read, check of the bytes and reply. The check runs it in its main host under
Node and in both browsers.

The chunk size is fixed per database, in its `meta` store, when the backend
creates it. To compare sizes without a setting in the runtime as released,
`nix run .#runtime-spike-storage-costs` links the released runtime with one
more JavaScript library (`modules/spikes/runtime/chunk-size.js`), which
changes the size the backend writes into `meta` for a database whose name
ends in `-chunk-<bytes>`, and names the engine so; the page reads the size
back from `meta` to confirm it. The released runtime has no such hook, and
the library is linked nowhere else. Each run gets a browser of its own with
its profile on disk (`launchPersistentContext()`): a context of a shared
browser is off the record, and Chromium keeps such a context's IndexedDB in
memory, which the check's runs, and the storage experiments above, use. The
profiles are on this host's ZFS.

**`fsync()` and what it syncs.** The backend's `fsync()` is a commit with
strict durability over the stores a file lives in, after its writes have
committed with the browser's default. Run under `strace -f` (counting
`fsync`, `fdatasync`, `sync_file_range` and `syncfs` across every process of
the browser, on a profile on disk), 50 rounds of a relaxed write transaction
followed by a strict one, from a page outside the runtime, show that a
strict commit syncs only if it writes:

| 50 rounds of a relaxed write, then | Chromium 149 | Firefox 151 |
| --- | --- | --- |
| nothing | no sync call | no sync call |
| an empty strict transaction | no sync call | no sync call |
| a strict transaction that puts a record back | 50 `fdatasync` | 50 `fsync` |

The backend's `fsync()` was the empty kind, so it made nothing durable: the
first five-run set measured 35–90 µs for it, under a proxied read. It now
puts the file's inode record back as it is, inside the strict transaction,
which also brings that record under the barrier; the backend's own test
counts that each `fsync()` makes one strict commit over a file's stores and
that the commit writes, and fails against the empty one. With the runtime,
`storage-costs` at 16 KiB, page spinning then idle, made 181 `fdatasync`
calls in all in Chromium before the change and 373 after, and 671 `fsync`
calls in Firefox before and 886 after: some 200 more for its 202
`fsync()`s, each now one sync (the rest are the browsers' own, the install's
marker among them). The `fsync()` rows below are that cost: a disk sync on
this host's ZFS.

Five runs per browser, chunk size and page mode, released runtime with the
`fsync()` above. Each cell is the median over the runs of each run's
median, in µs, page spinning / page idle (`Atomics.waitAsync()`):

| Chromium 149 | 16 KiB | 64 KiB | 256 KiB |
| --- | --- | --- | --- |
| random 4 KiB read | 155 / 120 | 380 / 365 | 585 / 500 |
| random 64 KiB read | 215 / 215 | 525 / 360 | 570 / 510 |
| 4 KiB read, page round trip | 280 / 205 | 535 / 405 | 660 / 625 |
| 64 KiB read, page round trip | 480 / 425 | 740 / 535 | 720 / 670 |
| 64 KiB `write()`, sequential | 360 / 300 | 935 / 905 | 1820 / 1775 |
| 64-byte append `write()` | 415 / 275 | 495 / 395 | 1940 / 1705 |
| its `fsync()` | 570 / 475 | 585 / 520 | 545 / 505 |
| `fsync()` after the whole write | 1475 / 1370 | 690 / 570 | 830 / 615 |

| Firefox 151 | 16 KiB | 64 KiB | 256 KiB |
| --- | --- | --- | --- |
| random 4 KiB read | 160 / 140 | 260 / 240 | 480 / 480 |
| random 64 KiB read | 220 / 200 | 260 / 260 | 520 / 520 |
| 4 KiB read, page round trip | 280 / 320 | 380 / 420 | 660 / 640 |
| 64 KiB read, page round trip | 560 / 640 | 620 / 600 | 840 / 860 |
| 64 KiB `write()`, sequential | 380 / 360 | 380 / 380 | 700 / 700 |
| 64-byte append `write()` | 300 / 360 | 460 / 460 | 800 / 820 |
| its `fsync()` | 460 / 500 | 580 / 540 | 640 / 640 |
| `fsync()` after the whole write | 5100 / 4960 | 4740 / 4580 | 8280 / 7900 |

The step of each browser's clock (5 µs, 20 µs) bounds these; means run
10–40% above the medians, and a run's mean can be twice another's. A page
round trip includes checking the bytes read; Firefox's for 64 KiB sit some
0.4 ms above the read itself, Chromium's 0.2 ms (not broken down). The 64
KiB reads are at 64 KiB-aligned offsets (the 4 KiB ones at 4 KiB-aligned
ones), so none straddles a chunk boundary. Lookups at any offset do, the
more often the smaller the chunk, each costing a record more, so aligned
reads favour larger chunks, if anything.

The longest single read from the page took 24 ms at 16 KiB in Chromium and
21 ms in Firefox. One run's reads at 64 KiB in Chromium met a stall of the
disk (its single read took 163 ms, its 100 synced appends 2 s), in which
the batch of appends, one request, came back 1.06 s after the page's 1 s
spin had let go: late through the disk, not the page, which a reply that
waited for the page's thread comes at once after. No other reply in the 30
runs with the page spinning came late; the calls that held the page past
D6's 40 ms were the batched ones (the whole write, 256 reads, 100 appends
in one request). A lazy 4 KiB read costs a keystroke 0.2–0.32 ms at 16 KiB
chunks.

Storage (KiB), from the sizes of the files the browser keeps IndexedDB in
(Chromium's `estimate()` gives the same; Firefox's leaves out some 280 KiB
of its own), the same in every run: the growth over the steps, then the
whole once the browser closed, which includes the engine's installed data
(871 KiB in Chromium and 1,145 KiB in Firefox before the write):

| | 16 KiB | 64 KiB | 256 KiB |
| --- | --- | --- | --- |
| Chromium: the 4,200 KiB write | +4,251 | +4,280 | +4,294 |
| Chromium: the 100 appends (6.25 KiB) | +2,373 | +8,671 | +212 |
| Chromium: once closed | 7,495 | 6,661 | 5,377 |
| Firefox: the 4,200 KiB write | +6,248 | +5,504 | +11,459 |
| Firefox: the 100 appends | +3,263 | +6,703 to +6,735 | −3,038 |
| Firefox: once closed | 5,448 | 5,328 | 5,312 |

Everything stored beyond the file's bytes is the stores' own: each append
rewrites the file's last chunk whole (8, 40 and 104 KiB in), so 100 appends
write 0.8, 4 and 10 MiB. Firefox's write-ahead log holds them until a
checkpoint, which closing the browser makes: settled, 16 KiB chunks take
120 KiB (2.9% of the file) more than 64 KiB ones, and 256 KiB ones 16 KiB
less. Chromium's LevelDB keeps every rewrite until it compacts, which hadn't
happened when the browser closed but apparently had during the appends at
256 KiB; one run in five at 64 KiB closed at 14,648 KiB rather than 6,661.
The first five-run set, whose `fsync()` synced nothing, gave the same
reads, writes and storage within the runs' spread, and the same choice.

**Chromium's 64 KiB cliff.** At 64 KiB chunks Chromium is two to three times
slower than at 16 KiB, for writes as for reads. Two runs more with chunks of
32 KiB and of 65,000 bytes put the cliff at 64 KiB itself: 65,000-byte
chunks cost what 16 and 32 KiB ones do (4 KiB reads 135–140 µs against
295–300 µs at 65,536 bytes; 64 KiB writes 270–295 µs against 800–830 µs).
Blink stores a value whose serialized form exceeds 64 KiB
(`kIDBWrapThreshold`) as a Blob of its own (`IDBValueWrapper`), and a read
unwraps it by reading that Blob, which Chromium does in the context that
asked and in its browser process, never on the page's thread, so it costs
time but no wait for the page. (That the values never reach the page isn't
the reason: Firefox's Blob reads wait for the page although the Blob never
reaches it.) Firefox keeps a value out of line, in a file of its own, only
from much larger sizes (`dom.indexedDB.dataThreshold`; in Firefox 151 a
value of 768 KiB stayed in the database and one of 896 KiB went to a file).
The backend now makes this a limit: it creates databases with chunks of at
most 63 KiB, the rest of the 64 KiB left for the serialization's own bytes,
checked against its default at compile time. The measurements' library,
which changes the size as IndexedDB stores it, after the backend has chosen,
still makes larger ones for comparison.

**Decided: 16 KiB.** It is the cheapest chunk for the random 4 KiB read that
lookups make, the read the keystroke path pays for (1.6–3 times cheaper
than 64 KiB, 3–4.2 times cheaper than 256 KiB), the cheapest or as cheap
for appends and sequential writes, and it keeps every chunk well below
Chromium's cliff. What it costs: some 3% more storage in Firefox once
settled, more records per file (263 for this one), in Chromium more LevelDB
churn between compactions and a dearer `fsync()` after a large write. Reads
of 64 KiB at once, which 16 KiB chunks serve from four records, are still
the cheapest. The backend's default is now 16 KiB. A database keeps the
chunk size it was created with, so one made at 64 KiB keeps 64 KiB chunks
and works as before; only new databases take 16 KiB. Nothing outside tests
has created one yet.

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
  and passes every scenario under Node and in both browsers tested.
- **Threads beyond the pool (decided: a pool sized for the planned peak plus
  spares, strict, and topped up while idle).** The pool's size is the sum of
  shares derived in Nix, GLib's 3 (measured: what one GTask in flight keeps
  alive: GLib's worker-context thread and thread-pool spawner, kept for good,
  and a GTask worker), the OPFS backend's 1 and an engine's, plus a low-water
  mark of spares, GLib's share. A thread beyond it fails with `EAGAIN`
  (`-sPTHREAD_POOL_SIZE_STRICT=2`) instead of waiting for a Worker that can't
  start, and the host, whenever no request is pending, tops the pool back up
  to the mark of idle Workers, from its event loop; threads within the shares
  never start a top-up. Bursts within the pool start without an event-loop
  turn in both browsers; the pool runs out cleanly; a top-up of three Workers
  takes 54–60 ms, of one 47–48 ms. The spec (§5.3) takes this: an engine's
  share comes from its manifest, and the pool of a host is the runtime's
  shares plus its engine's plus the spares. Emscripten 6.0.9 writes
  `-sPTHREAD_POOL_SIZE` into the runtime's JavaScript verbatim, inside the
  modularized factory where `Module` is the host's settings object, so the
  runtime can link with the Nix-derived base plus
  `Module["ibuswebEngineThreads"]` and start with the engine's share in the
  pool (checked on a probe linked that way: base 2 plus 3 from `Module`
  gave 5 pool Workers); the low-water mark covers GLib's
  share, since GLib aborts or leaves work queued when it can't get a thread.
  With OPFS out of the design (below), the OPFS backend's share becomes the
  IndexedDB backend's, which also runs on a thread of its own. Still open: a
  rule for engines that run GTasks concurrently, since GLib's share covers
  one GTask in flight and each concurrent one can take another worker, up
  to GTask's pool of 10 and beyond; and a public Emscripten call to grow the
  pool, on which the top-up could rest instead of the internal `PThread`
  (upstream-trackable). The runtime's JavaScript surface the host uses
  (`HEAPU8`, `PThread`) stays outside the export manifest, which lists only
  WASM symbols; the spec notes it.
- **The page's spin stays as D6 (≤ 40 ms, then consume and replay)**, and by
  design nothing the host does during a request waits for the page any more,
  with two exceptions in Firefox: a Blob read (next item), which the storage
  design now avoids, and a request that lands during a top-up's
  `new Worker()` calls (about 1 ms, only when no request was pending), which
  costs at most a replay. The spec records the constraint with D6 (§6.2.6):
  nothing the Worker does for a request may wait for the page's main thread. In the
  harness's model of D6, the only other calls over 40 ms are pumps that start
  threads on Workers that have never run one in Chromium (about 12 ms per
  first thread; `spawn(4)` 50 ms). Running a thread on each pool Worker at
  startup would move that cost out of keystrokes (not tried).
- **R3 is settled for the runtime's configuration** (`-sMAIN_MODULE=2`,
  WasmFS) under Node, Chromium 149 and Firefox 151: side modules load into a
  runtime whose pool already runs, threads call into them, exceptions cross
  modules, and `dlopen()` with live threads works once 0015 is applied.
- **OPFS works, but is out of the design.** WasmFS's OPFS backend mounts,
  writes, `fsync`s and reads back from the host's thread and from pthreads
  while the host sleeps, and takes one pool Worker for good. But Firefox
  reads a file opened read-only (WasmFS's Blob path) only while the page's
  main thread is free, and a sync access handle, which doesn't wait, takes
  an exclusive lock across the origin in Firefox (and, by the standard,
  Safari); only Chromium shares read-only ones. **Decided:** engine and user
  data live in IndexedDB, as chunks whose values are ArrayBuffers, never
  Blobs, behind a WasmFS IndexedDB backend of our own that reads and writes
  them lazily on a thread of its own (milestone M0.5, before M1; an upstream
  candidate, `wasmfs_create_idb_backend`). IndexedDB's ArrayBuffer reads
  complete during the spin in both browsers and take no lock (above). ZenFS
  isn't adopted (its IndexedDB support targets Emscripten's legacy file
  system, its synchronous path preloads everything, and it is LGPL-3.0), and
  IDBFS belongs to the legacy file system too.
- **§6.2.1** gains a `wake` word: the page bumps it after posting a request,
  and the relay watches it. The host sleeps on a word in WASM memory, not on
  the request word §5.2.4 named. Any relay must forward against the value it
  last forwarded, never a re-read.
- **The relay is host-side** (spec §5.2.4, §9.2). It holds the runtime's
  memory (it writes the wake word there), so it belongs with the host, not the
  page; the page still touches only the control buffer.
- **Each engine Worker costs one more, small Worker,** the relay, which holds
  no runtime instance. It starts as a nested module Worker in Chromium 149
  and Firefox 151; WebKit wasn't run. In the browsers the relay and the
  in-runtime sleep add about 20 µs to a request that finds the host asleep
  (cold-wake means, one run), against 1–3 µs under Node.
- **One relay per page could serve every engine** (an option, not adopted):
  a page-wide doorbell word that the page bumps after posting to any engine,
  per-engine sequence words in each control buffer, and one relay that, on
  each ring, scans the engines' sequence words and bumps the WASM wake word
  of each engine whose sequence moved. It would need every engine's memory,
  so it is still host-side, shared by the hosts.
- **Memory is fixed per Worker, made by the host** (Memory growth, above):
  growth traps in V8, whose fix is in no Node release line. The runtime
  imports a memory of the engine manifest's `memory` bytes whose maximum is
  its size, and won't start without one. Every pool Worker holds an instance
  of the runtime: about 18 MiB in Chromium, 12–16 MiB in Firefox, 42 MiB
  under Node, and its first thread 3–10 MiB more. A top-up of three Workers
  takes 54–60 ms in the browsers (released runtime), 18–20 ms per Worker,
  and a top-up of one 47–48 ms; a Worker's first thread takes about 12 ms
  more in Chromium, 2–5 ms in Firefox, since each loads the runtime and
  every side module.
- **Exceptions:** `-fwasm-exceptions` emits the legacy encoding, which Firefox
  warns is deprecated. `-sWASM_LEGACY_EXCEPTIONS=0` emits the standard one,
  Baseline 2025 (newly available) and supported by Node v24.20, but outside
  the project's minimum versions; the switch is a follow-up (spec R18).
- `fsync()` on WasmFS's memory and Node backends doesn't proxy at all, so
  Node can't exhibit R2's promise-proxied case. On OPFS it does, and it
  completes in both browsers while the host sleeps; the IndexedDB backend,
  proxied the same way, is M0.5's to check.
- **One writer per engine's user data, in chunks of 16 KiB (M0.5).** The
  host holding `ibus-web:writer:<name>` mounts the engine's user data
  read-write; every other host mounts it read-only and reports
  `storage: read-only`. A page that terminates the writer waits for its lock
  before starting the engine's next host (Chromium lets go of it some 2 s
  late), and keeps out of the engine's databases, whose writes its own
  transactions would hold up while it spins. The backend's chunks are now
  16 KiB, at most 63 KiB so that Chromium never keeps one as a Blob: a lazy
  4 KiB read costs a keystroke 0.2–0.32 ms in both browsers, and no read or
  write waits for the page's spin. `fsync()` commits strictly a transaction
  that writes, since neither browser syncs an empty one.
