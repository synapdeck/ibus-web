# WasmFS: a destroyed ProxyWorker's heartbeat keeps running its freed queue

**Issue posted; the PR is still to post.** The issue went up as
[#27858](https://github.com/emscripten-core/emscripten/issues/27858)
(2026-10-02, no replies yet). Post the fix (patch 0018) as a PR with
`other.test_wasmfs_proxy_worker_exit` from
`emscripten-wasmfs-proxy-worker-heartbeat.tests.patch`, saying "Fixes:
#27858".

Checked against `main` 5977ecc (2026-10-02): `thread_utils.h` and the
heartbeat are unchanged, and 0018 applies there alone with offsets only (-5
and -23 lines). With Emscripten's runner, emsdk's toolchain for `main`
(`test/emsdk_version.txt` dbaebb43: clang 24.0.0git d3e9891b, Binaryen 133)
and Node 24.21.0, `other.test_wasmfs_proxy_worker_exit` fails on `main`
(`Assertion failed: pthread_self()` in `emscripten_proxy_execute_queue`) and
passes on `main` with 0018 alone and with the whole stack;
`other.test_gen_sig_info` passes with 0018 (logs:
`task14-upstream-main-{unpatched,0018,stack}.log`).

**Draft: new issue, with a PR.**

## Issue title

WasmFS: ProxyWorker's 50 ms heartbeat outlives its thread and runs the freed queue on a pooled Worker (`Assertion failed: pthread_self()` in `emscripten_proxy_execute_queue`)

## Issue body

---

`emscripten::ProxyWorker` (`system/lib/wasmfs/thread_utils.h`), which the
OPFS and fetch backends use for their dedicated thread, starts a heartbeat
on that thread: `_wasmfs_thread_utils_heartbeat()` sets a 50 ms
`setInterval` that calls `emscripten_proxy_execute_queue()` on the
ProxyWorker's queue. Nothing stops it except `ABORT`.

`~ProxyWorker()` cancels and joins the thread, and the queue (a member) is
freed after that. The Worker the thread ran on goes back to the pool, not
terminated, and its JavaScript timers go with it. So every 50 ms the
Worker calls `emscripten_proxy_execute_queue()` with a freed queue:

- while the Worker is idle, `pthread_self()` is null and, with assertions,
  `assert(pthread_self())` aborts the program;
- without assertions, or once the pool hands the Worker to another thread,
  it locks the freed queue's mutex and walks its freed task queues.

Backends are destroyed with the `WasmFS` object at exit (`EXIT_RUNTIME`),
so any program with an OPFS or fetch backend can abort at exit if a
heartbeat fires on a Worker whose backend thread has already been joined
while the main thread is still destroying the others or shutting down. We
hit it in about 1 run in 6 of a program with four backends of our own,
built on `ProxyWorker`, in headless Chromium under load (0 in 250 on an
idle machine), and every time once a destroyed backend's Worker stays idle
for 50 ms before the program exits.

**Version of emscripten/emsdk:**

```
emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 6.0.9-git
clang version 22.1.8
Target: wasm32-unknown-emscripten
Thread model: posix
InstalledDir: /nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin
```

This is the 6.0.9 release tag as packaged by nixpkgs, built against its own
LLVM 22.1.8, so there is no commit hash. Node.js v24.19.0, x86_64 Linux.

**Test case** (`proxy_worker_exit.cpp`). It includes the internal header
directly, as a backend does, and the headers `thread_utils.h` uses without
including them (`<assert.h>`, `<mutex>`, `<condition_variable>`):

```c++
#include <emscripten/emscripten.h>
#include <emscripten/eventloop.h>
#include <stdio.h>
#include <thread>

// thread_utils.h uses these without including them.
#include <assert.h>
#include <condition_variable>
#include <mutex>

#include "thread_utils.h"

#define IDLE_MS 500

// A ProxyWorker can't be created on the main browser thread.
static void use_worker() {
  std::thread([] {
    emscripten::ProxyWorker worker;
    bool ran = false;
    worker([&] { ran = true; });
    assert(ran);
  }).join();
}

static void second_idle(void*) {
  printf("done\n");
  emscripten_force_exit(0);
}

static void first_idle(void*) {
  use_worker();
  emscripten_set_timeout(second_idle, IDLE_MS, nullptr);
}

int main() {
  use_worker();
  emscripten_set_timeout(first_idle, IDLE_MS, nullptr);
}
```

**Failing command line in full:**

```
$ em++ -O2 -sASSERTIONS -pthread -sWASMFS -sPTHREAD_POOL_SIZE=2 -sEXIT_RUNTIME \
    -I$EMSCRIPTEN/system/lib/wasmfs proxy_worker_exit.cpp -o t.js
$ node t.js
Aborted(Assertion failed: pthread_self(), at: /emsdk/emscripten/system/lib/pthread/proxying.c,113,emscripten_proxy_execute_queue)
worker sent an error! undefined:undefined: Aborted(Assertion failed: pthread_self(), at: /emsdk/emscripten/system/lib/pthread/proxying.c,113,emscripten_proxy_execute_queue)
node:internal/event_target:1136
  process.nextTick(() => { throw err; });
                           ^

RuntimeError: Aborted(Assertion failed: pthread_self(), at: /emsdk/emscripten/system/lib/pthread/proxying.c,113,emscripten_proxy_execute_queue)
    at abort (t.js:1:14112)
    at ___assert_fail (t.js:1:28712)
    at wasm://wasm/000540c2:wasm-function[75]:0x2f43
    at t.js:1:15050
    at Timeout._onTimeout (t.js:1:37400)
[exit status 1]
```

It fails 10 times in 10. Without `-sASSERTIONS` it prints `done`: the
freed queue is still readable and empty, so nothing shows.

**Where:**

- The heartbeat
  ([libwasmfs.js#L604-L614](https://github.com/emscripten-core/emscripten/blob/6.0.9/src/lib/libwasmfs.js#L604-L614)),
  started on the worker thread
  ([thread_utils.h#L64](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/thread_utils.h#L64)).
- The destructor cancels and joins, then the `queue` member is destroyed
  ([thread_utils.h#L91-L94](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/thread_utils.h#L91-L94),
  [proxying.c#L59](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/pthread/proxying.c#L59)).
- The exiting thread clears `pthread_self()`
  ([pthread_create.c#L370](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/pthread/pthread_create.c#L370)),
  and its Worker goes back to the pool, not terminated
  ([libpthread.js#L224-L236](https://github.com/emscripten-core/emscripten/blob/6.0.9/src/lib/libpthread.js#L224-L236)).
- The next tick fails here
  ([proxying.c#L113](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/pthread/proxying.c#L113)).

**Suggested fix:** stop the heartbeat before the thread is cancelled. A
Worker hosts one thread at a time, so it needs only one variable for the
timer, and `~ProxyWorker()` clears it with a synchronous call proxied to the
thread (only the thread can reach its Worker's timers) before it cancels and
joins it, so no tick can follow the queue being freed. 25 lines added, 3
removed:

```diff
diff --git a/src/lib/libsigs.js b/src/lib/libsigs.js
--- a/src/lib/libsigs.js
+++ b/src/lib/libsigs.js
@@ -465,6 +465,7 @@ sigs = {
   _wasmfs_opfs_write_access__sig: 'iipij',
   _wasmfs_stdin_get_char__sig: 'i',
   _wasmfs_thread_utils_heartbeat__sig: 'vp',
+  _wasmfs_thread_utils_heartbeat_stop__sig: 'v',
   alBuffer3f__sig: 'viifff',
   alBuffer3i__sig: 'viiiii',
   alBufferData__sig: 'viipii',
diff --git a/src/lib/libwasmfs.js b/src/lib/libwasmfs.js
--- a/src/lib/libwasmfs.js
+++ b/src/lib/libwasmfs.js
@@ -601,17 +601,25 @@ addToLibrary({
   _wasmfs_copy_preloaded_file_data: (index, buffer) =>
     HEAPU8.set(wasmFSPreloadedFiles[index].fileData, buffer),

-  _wasmfs_thread_utils_heartbeat__deps: ['emscripten_proxy_execute_queue'],
+  // A Worker hosts one thread at a time, so it runs at most one heartbeat.
+  $wasmFSHeartbeat: null,
+  _wasmfs_thread_utils_heartbeat__deps: ['emscripten_proxy_execute_queue',
+                                         '$wasmFSHeartbeat'],
   _wasmfs_thread_utils_heartbeat: (queue) => {
-    var intervalID =
+    wasmFSHeartbeat =
       setInterval(() => {
         if (ABORT) {
-          clearInterval(intervalID);
+          clearInterval(wasmFSHeartbeat);
         } else {
           _emscripten_proxy_execute_queue(queue);
         }
       }, 50);
   },
+  _wasmfs_thread_utils_heartbeat_stop__deps: ['$wasmFSHeartbeat'],
+  _wasmfs_thread_utils_heartbeat_stop: () => {
+    clearInterval(wasmFSHeartbeat);
+    wasmFSHeartbeat = null;
+  },

   _wasmfs_stdin_get_char__deps: ['$FS_stdin_getChar'],
   _wasmfs_stdin_get_char: () => {
diff --git a/system/lib/wasmfs/thread_utils.h b/system/lib/wasmfs/thread_utils.h
--- a/system/lib/wasmfs/thread_utils.h
+++ b/system/lib/wasmfs/thread_utils.h
@@ -15,6 +15,7 @@

 extern "C" {
 void _wasmfs_thread_utils_heartbeat(em_proxying_queue* ctx);
+void _wasmfs_thread_utils_heartbeat_stop(void);
 }

 namespace emscripten {
@@ -89,6 +90,18 @@ public:

   // Kill the worker thread.
   ~ProxyWorker() {
+    // Stop the heartbeat first, on the thread, the only one that can reach
+    // its timer: the thread's Worker outlives it and goes back to the pool,
+    // timers and all, while the queue the heartbeat executes is freed once
+    // the thread is joined. The stop can't overtake the heartbeat's start:
+    // the thread runs its queue only from its event loop, which it enters
+    // after starting the heartbeat. Work the thread is already running, and
+    // anything queued before the stop, finishes first.
+    [[maybe_unused]] bool stopped =
+      queue.proxySync(thread.native_handle(),
+                      []() { _wasmfs_thread_utils_heartbeat_stop(); });
+    // The thread takes proxied work until it is canceled below.
+    assert(stopped);
     pthread_cancel(thread.native_handle());
     thread.join();
   }
```

With this applied the test case prints `done` and exits 0, 10 times in 10.
`setInterval()` returns an object in Node, which is why the timer stays in
JavaScript rather than being handed to C++ to clear.

The stop can't overtake the heartbeat's start: a ProxyWorker's thread
runs its queue only from its event loop (the heartbeat's ticks included),
which it enters after starting the heartbeat, so a destructor that runs as
soon as the constructor returns still queues the stop behind the start.
`proxySync()` fails only when the task can't be queued (no memory for it)
or its thread ends before running it, and this thread takes proxied work
until the destructor cancels it, so the destructor asserts that the stop
ran.

The proxied call costs one more round trip to the thread when a backend is
destroyed; the join already waits for one. It also changes when the thread
is canceled: the stop runs after whatever the thread is running and
anything queued before it, so the destructor now lets that work finish
before it cancels the thread, where a cancel alone could end the thread at
a cancellation point inside it. A backend is destroyed once nothing is
using it, so there is normally nothing to wait for; work that never
finishes now holds up the destructor rather than being cut short. While
the program runs, the destructor is the only way a ProxyWorker's thread
ends, so stopping the heartbeat there covers every case. Alternatives
considered:

- A `thread_local` whose destructor stops the heartbeat as the thread exits
  (thread-specific data destructors run on cancellation too). It also
  covers a thread that ends some other way, but leans on libc++abi's
  `__cxa_thread_atexit` key, and has to be registered before the heartbeat
  starts: registering can block on a lock, and a blocked pthread acts on a
  pending cancel, which a destructor running just after the constructor
  returns can send.
- Checking in each tick that `pthread_self()` is still the thread that
  started the heartbeat. The pool often hands the same Worker to a new
  thread whose `pthread_t` is the freed one's address.

**Test for the PR,** in the suite's format (also as
`emscripten-wasmfs-proxy-worker-heartbeat.tests.patch` beside this draft):
`other.test_wasmfs_proxy_worker_exit` is the test case above. It fails on
6.0.9 with the assertion and passes with the fix:

```diff
diff --git a/test/test_other.py b/test/test_other.py
--- a/test/test_other.py
+++ b/test/test_other.py
@@ -13867,6 +13867,16 @@ Module.postRun = () => {{
     create_file('js_backend_files/file.dat', 'data')
     self.do_runf_out_file('wasmfs/wasmfs_before_preload.c', cflags=['--preload-file', 'js_backend_files/file.dat'])

+  @requires_pthreads
+  def test_wasmfs_proxy_worker_exit(self):
+    # The heartbeat a ProxyWorker's thread runs must end with the thread, not
+    # keep running the freed queue on the Worker it leaves in the pool.
+    self.set_setting('WASMFS')
+    self.set_setting('PTHREAD_POOL_SIZE', 2)
+    self.set_setting('EXIT_RUNTIME')
+    self.cflags += ['-pthread', '-I' + path_from_root('system/lib/wasmfs')]
+    self.do_runf('wasmfs/wasmfs_proxy_worker_exit.cpp', 'done\n')
+
   def test_hello_world_above_2gb(self):
     self.do_runf_out_file('hello_world.c', cflags=['-sGLOBAL_BASE=2GB', '-sINITIAL_MEMORY=3GB'])

```

(`test/wasmfs/wasmfs_proxy_worker_exit.cpp` is the test case above, with a
comment at the top.)

---

## Notes for the user

- **How the fix was tested.**
  - The test case on nixpkgs' 6.0.9 with our stack (0001–0017, none of which
    touches `thread_utils.h` or the heartbeat): 10 of 10 runs abort; with
    0018, 10 of 10 print `done`.
  - `other.test_wasmfs_proxy_worker_exit` and `other.test_gen_sig_info`
    with Emscripten's runner, on a writable copy of the tree: the first
    FAILs without 0018 (the assertion) and both are ok with it.
    `tools/maint/gen_sig_info.py` reproduces `libsigs.js` exactly with the
    new `_wasmfs_thread_utils_heartbeat_stop__sig: 'v'` entry.
  - Our `checks.emscripten-fixes` runs the same program on our test link
    (`modules/emscripten/checks/fixes/proxy-worker-exit.cpp`): red 20 of
    20 without 0018, green 20 of 20 with it.
  - Our IndexedDB backend's browser tests: `sweep.1`/`sweep.2` 201 times in
    headless Chromium with every core busy: 39 of 402 programs aborted at
    exit (`RuntimeError: unreachable` after they had reported success)
    without 0018, 0 with it. On an idle machine, 0 of 250 failed even
    without it, which is why the browser rate in the issue is hedged.
  - The browser OPFS and fetch tests weren't run.
- **The patch applies to `main`** (a0014542110d, 2026-10-02) with offsets
  only (`git apply --check`); `thread_utils.h` and the heartbeat are
  byte-identical on 6.0.9, 6.0.10 and `main`.
- **Duplicate search.** `gh` searches of issues and PRs for "heartbeat",
  "ProxyWorker", "_wasmfs_thread_utils_heartbeat" and "OPFS backend destroy
  worker crash" turned up only the PRs that made the heartbeat: #17869 ("Add
  a hack to work around deadlocks"), #19697 (moved it to JS) and #19836 (a
  missing dep), plus #24370/#25114 (a race in the ProxyWorker's
  construction). None reports this.
- ibus-web carries this fix as
  `modules/emscripten/patches/0018-wasmfs-proxy-worker-heartbeat.patch`. It
  matters to us because a backend whose database fails to open is torn down
  at once, leaving its Worker idle in the pool, and every backend is
  destroyed at exit.
