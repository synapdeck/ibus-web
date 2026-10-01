# pthreads: a blocked main thread never reclaims detached threads

**Draft: new issue, with a PR.** #16763 reported the symptom in 2022 and
was closed by its reporter after the workarounds in the thread; no change
followed. This draft asks for the fix itself and offers one.

## Issue title

Threads that exit unjoined leak their stack and Worker while the main thread is blocked

## Issue body

---

A thread that exits without being joined on the main runtime thread (a
detached thread, or one that another thread joins) only gets its memory freed
and its Worker returned to the pool when the main thread's event loop handles
a `CMD_CLEANUP_THREAD` message. A main thread that blocks instead (in
`emscripten_futex_wait()`, a `pthread_cond_wait()`, a `pthread_join()` on
something else, or a loop that waits for work on a futex as a native-style
event loop does) never handles it. Each such thread then keeps its whole
block (stack, TLS and `struct pthread`), and its Worker stays out of the
pool, so the next `pthread_create()` starts a new Worker: a program that
uses a thread pool (GLib's, or any whose workers exit after an idle timeout)
leaks a stack and a Worker per thread until it runs out of memory.

This is the case sbc100 described in #16763 ("recycling detached threads
requires the main thread to be running its event loop"). The workarounds
given there (join every thread on the main thread, `PROXY_TO_PTHREAD`, a
main loop) don't fit code that blocks by design, and the blocked main thread
already wakes for, and runs, work other threads proxy to it: the cleanup can
take the same route.

**Version of emscripten/emsdk:**

```
emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 6.0.9-git
clang version 22.1.8
Target: wasm32-unknown-emscripten
Thread model: posix
InstalledDir: /nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin
```

This is the 6.0.9 release tag as packaged by nixpkgs. nixpkgs builds it against
its own LLVM 22.1.8, so there is no commit hash. Node.js v24.20.0, x86_64 Linux.

**Test case** (`detached.c`):

```c
#include <emscripten/threading.h>
#include <malloc.h>
#include <pthread.h>
#include <stdio.h>

static void *nothing(void *arg) { return NULL; }

/* Blocks for ms without returning to the event loop. A futex wait can end
 * early, on a notification, so keep waiting until the time is up. */
static void block(double ms) {
  static int never;
  double end = emscripten_get_now() + ms;
  for (double left = ms; left > 0; left = end - emscripten_get_now())
    emscripten_futex_wait(&never, 0, left);
}

int main(void) {
  for (int round = 1; round <= 5; round++) {
    for (int i = 0; i < 4; i++) {
      pthread_t thread;
      pthread_create(&thread, NULL, nothing, NULL);
      pthread_detach(thread);
    }
    block(200);
    printf("round %d: %zu bytes in use\n", round, mallinfo().uordblks);
  }
  return 0;
}
```

**Failing command line in full:**

```
$ emcc -O2 -pthread -sPTHREAD_POOL_SIZE=4 detached.c -o detached.js && node detached.js
round 1: 299208 bytes in use
round 2: 596808 bytes in use
round 3: 894408 bytes in use
round 4: 1192008 bytes in use
round 5: 1489608 bytes in use
```

Every round leaks four threads' blocks (64 KiB stacks here), and every round
after the first starts four new Workers. Each thread had long exited: the
main thread was blocked for 200 ms after creating them.

<details>
<summary>Full compile and link output with <code>-v</code> appended (cache and scratch paths shortened)</summary>

```
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/clang -target wasm32-unknown-emscripten -fignore-exceptions -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr --sysroot=$EM_CACHE/sysroot -resource-dir=/nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter$EM_CACHE/sysroot/include -iwithsysroot/include/c++/v1 -D__EMSCRIPTEN_SHARED_MEMORY__=1 -Xclang -iwithsysroot/include/fakesdl -Xclang -iwithsysroot/include/compat -O2 -pthread -v -c detached.c -o /tmp/emscripten_temp_5yoquq1q/detached.o
clang version 22.1.8
Target: wasm32-unknown-emscripten
Thread model: posix
InstalledDir: /nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin
 (in-process)
 "/nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin/clang-22" -cc1 -triple wasm32-unknown-emscripten -O2 -emit-obj -disable-free -clear-ast-before-backend -disable-llvm-verifier -discard-value-names -main-file-name detached.c -mrelocation-model static -mframe-pointer=none -ffp-contract=on -fno-rounding-math -mconstructor-aliases -target-feature +atomics -target-feature +bulk-memory -target-feature +mutable-globals -target-feature +sign-ext -target-cpu generic -fvisibility=hidden -debugger-tuning=gdb -fdebug-compilation-dir=. -v -fcoverage-compilation-dir=. -resource-dir /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter $EM_CACHE/sysroot/include -iwithsysroot /include/c++/v1 -D __EMSCRIPTEN_SHARED_MEMORY__=1 -isysroot $EM_CACHE/sysroot -internal-isystem /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/include -internal-isystem $EM_CACHE/sysroot/include/wasm32-emscripten -internal-isystem $EM_CACHE/sysroot/include -ferror-limit 19 -pthread -fgnuc-version=4.2.1 -fskip-odr-check-in-gmf -fignore-exceptions -vectorize-loops -vectorize-slp -iwithsysroot/include/fakesdl -iwithsysroot/include/compat -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr -o /tmp/emscripten_temp_5yoquq1q/detached.o -x c detached.c
clang -cc1 version 22.1.8 based upon LLVM 22.1.8 default target x86_64-unknown-linux-gnu
ignoring nonexistent directory "$EM_CACHE/sysroot/include/wasm32-emscripten"
ignoring duplicate directory "$EM_CACHE/sysroot/include"
#include "..." search starts here:
#include <...> search starts here:
 $EM_CACHE/sysroot/include/c++/v1
 $EM_CACHE/sysroot/include/fakesdl
 $EM_CACHE/sysroot/include/compat
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/include
 $EM_CACHE/sysroot/include
End of search list.
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/clang --version
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/wasm-ld -o detached.wasm /tmp/tmpbu6aqgh_libemscripten_js_symbols.so -Bstatic --import-memory --shared-memory --strip-debug --export=_emscripten_stack_alloc --export=_emscripten_thread_free_data --export=_emscripten_thread_crashed --export=__wasm_call_ctors --export=_emscripten_tls_init --export=_emscripten_thread_init --export=pthread_self --export=__set_thread_state --export=emscripten_stack_get_current --export=_emscripten_stack_restore --export=emscripten_stack_set_limits --export=_emscripten_thread_exit --export-if-defined=__start_em_asm --export-if-defined=__stop_em_asm --export-if-defined=__start_em_lib_deps --export-if-defined=__stop_em_lib_deps --export-if-defined=__start_em_js --export-if-defined=__stop_em_js --export-if-defined=main --export-if-defined=__main_argc_argv --export-table -z stack-size=65536 --no-growable-memory --initial-memory=16777216 --no-entry --no-stack-first --table-base=1 --global-base=1024 /tmp/emscripten_temp_5yoquq1q/detached.o -L$EM_CACHE/sysroot/lib/wasm32-emscripten -L/nix/store/03iyrnrsxnbc64y6r62irmlbnbap5ya2-emscripten-6.0.9/share/emscripten/src/lib $EM_CACHE/sysroot/lib/wasm32-emscripten/crtbegin-mt.o -lGL-mt-getprocaddr -lal -lhtml5 -lstubs -lnoexit -lc-mt -ldlmalloc-mt -lclang_rt.builtins-mt -lsockets-mt -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/llvm-objcopy detached.wasm detached.wasm '--remove-section=llvm.func_attr.annotate.*' --remove-section=producers --remove-section=name '--remove-section=.debug*'
 /nix/store/lfaydgacdyngci7p60s8wwvgdm74fjkx-nodejs-24.19.0/bin/node /nix/store/03iyrnrsxnbc64y6r62irmlbnbap5ya2-emscripten-6.0.9/share/emscripten/tools/compiler.mjs -
 /nix/store/nd1279k2zlbp23gfqcl0qp5xk40xlxr8-binaryen-132/bin/wasm-opt --strip-target-features --post-emscripten -O2 --low-memory-unused --zero-filled-memory --pass-arg=directize-initial-contents-immutable detached.wasm -o detached.wasm --mvp-features --enable-threads --enable-bulk-memory --enable-bulk-memory-opt --enable-call-indirect-overlong --enable-multivalue --enable-mutable-globals --enable-nontrapping-float-to-int --enable-reference-types --enable-sign-ext
 /nix/store/lfaydgacdyngci7p60s8wwvgdm74fjkx-nodejs-24.19.0/bin/node /nix/store/03iyrnrsxnbc64y6r62irmlbnbap5ya2-emscripten-6.0.9/share/emscripten/tools/acorn-optimizer.mjs /tmp/emscripten_temp_5yoquq1q/detached.js JSDCE --minify-whitespace -o /tmp/emscripten_temp_5yoquq1q/detached.jso1.js
```

</details>

**Where:** a thread that exits detached calls `_emscripten_thread_cleanup()`
on itself
([pthread_create.c#L376-L377](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/pthread/pthread_create.c#L376-L377)),
and `pthread_join()` calls it for the joined thread
([pthread_join.c#L48](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/libc/musl/src/thread/pthread_join.c#L48)).
Off the main thread, that only posts `CMD_CLEANUP_THREAD` to it
([libpthread.js#L618-L629](https://github.com/emscripten-core/emscripten/blob/6.0.9/src/lib/libpthread.js#L618-L629)),
which its event loop handles
([libpthread.js#L318-L323](https://github.com/emscripten-core/emscripten/blob/6.0.9/src/lib/libpthread.js#L318-L323)).
A blocked main thread does run `_emscripten_yield()` from every
`emscripten_futex_wait()`
([emscripten_futex_wait.c#L204](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/pthread/emscripten_futex_wait.c#L204)),
which runs the calls other threads proxied to it
([emscripten_yield.c#L50](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/pthread/emscripten_yield.c#L50)),
but the cleanup isn't one of them.

**Suggested fix:** hand the thread to the main thread through a lock-free
list, which `emscripten_main_thread_process_queued_calls()` drains, and wake
the main thread with `_emscripten_thread_notify()`; keep posting the message,
now as a signal to drain the list, for a main thread that is idle in its event
loop. Because a wait on the main thread can now free a thread, `dlopen()`'s
sync, which takes the list of threads and then proxies to each in turn,
holds the cleanups off while it goes through the list and runs them as soon
as it is done: a proxy can wait (on the queue's mutex, or in `malloc()`)
between any check of the list and its first use of a thread's struct. A
thread that has ended meanwhile stays allocated with its mailbox closed, so
the proxy fails cleanly, as it does in 6.0.9; nothing in the sync waits on a
cleanup, so holding them can't deadlock. The sync also skips a thread
already gone at its turn. 108 lines added, 15 removed (99 and 6 ignoring
the re-indented loops).

```diff
diff --git a/src/lib/libpthread.js b/src/lib/libpthread.js
--- a/src/lib/libpthread.js
+++ b/src/lib/libpthread.js
@@ -93,6 +93,7 @@ var LibraryPThread = {
 #endif
                    '$spawnThread',
                    '_emscripten_thread_free_data',
+                   '_emscripten_thread_run_deferred_cleanups',
                    'exit',
                    'pthread_self',
                    '__set_thread_state',
@@ -316,10 +317,12 @@ var LibraryPThread = {
             spawnThread(d);
             break;
           case {{{ CMD_CLEANUP_THREAD }}}:
+            // The thread may already have been cleaned up, if the main thread
+            // processed its queued calls since the message was sent.
             // cleanupThread needs to be run via callUserCallback since it calls
             // back into user code to free thread data. Without this it's possible
             // the unwind or ExitStatus exception could escape here.
-            callUserCallback(() => cleanupThread(d.thread));
+            callUserCallback(() => __emscripten_thread_run_deferred_cleanups());
             break;
 #if MAIN_MODULE
           case {{{ CMD_MARK_AS_FINISHED }}}:
@@ -615,6 +618,7 @@ var LibraryPThread = {
     };
   },
 
+  _emscripten_thread_cleanup__deps: ['_emscripten_thread_defer_cleanup'],
   _emscripten_thread_cleanup: (thread) => {
     // Called when a thread needs to be cleaned up so it can be reused.
     // A thread is considered reusable when it either returns from its
@@ -625,7 +629,13 @@ var LibraryPThread = {
     dbg(`_emscripten_thread_cleanup: ${ptrToString(thread)}`)
 #endif
     if (!ENVIRONMENT_IS_PTHREAD) cleanupThread(thread);
-    else postMessage({ cmd: {{{ CMD_CLEANUP_THREAD }}}, thread });
+    else {
+      // A main thread blocked in emscripten_futex_wait (or otherwise processing
+      // its queued calls) cleans the thread up there; the message covers one
+      // that is idle in its event loop.
+      __emscripten_thread_defer_cleanup(thread);
+      postMessage({ cmd: {{{ CMD_CLEANUP_THREAD }}} });
+    }
   },
 
   _emscripten_thread_set_strongref: (thread) => {
@@ -1230,7 +1240,9 @@ var LibraryPThread = {
 
   // Asynchronous version _emscripten_dlsync_threads.
   // This is always called on the main thread. This work happens asynchronously.
-  $dlsyncThreadsAsync__deps: ['_emscripten_proxy_dlsync_async', '$makePromise'],
+  $dlsyncThreadsAsync__deps: ['_emscripten_proxy_dlsync_async', '$makePromise',
+                              '_emscripten_thread_hold_cleanups',
+                              '_emscripten_thread_release_cleanups'],
   $dlsyncThreadsAsync: async () => {
     const caller = PThread.currentProxiedOperationCallerThread;
 #if PTHREADS_DEBUG
@@ -1254,14 +1266,23 @@ var LibraryPThread = {
     // Any new threads that are created after this call will automatically be
     // in sync because we call `__emscripten_dlsync_self` in
     // invokeEntryPoint before the threads entry point is called.
-    for (const ptr of Object.keys(PThread.pthreads)) {
-      const pthread_ptr = Number(ptr);
-      if (pthread_ptr !== caller && !PThread.finishedThreads.has(pthread_ptr)) {
-        info = makePromise();
-        __emscripten_proxy_dlsync_async(pthread_ptr, info.id);
-        PThread.outstandingPromises[pthread_ptr] = info;
-        promises.push(info.promise);
+    // Proxying can wait, and a wait on the main thread cleans up threads
+    // that have ended, which would free structs this list still names; hold
+    // that off until the list is done. A thread that has ended but isn't
+    // cleaned up yet refuses the proxy.
+    __emscripten_thread_hold_cleanups();
+    try {
+      for (const ptr of Object.keys(PThread.pthreads)) {
+        const pthread_ptr = Number(ptr);
+        if (pthread_ptr !== caller && ptr in PThread.pthreads && !PThread.finishedThreads.has(pthread_ptr)) {
+          info = makePromise();
+          __emscripten_proxy_dlsync_async(pthread_ptr, info.id);
+          PThread.outstandingPromises[pthread_ptr] = info;
+          promises.push(info.promise);
+        }
       }
+    } finally {
+      __emscripten_thread_release_cleanups();
     }
 
 #if PTHREADS_DEBUG
@@ -1280,7 +1301,9 @@ var LibraryPThread = {
   // synchronously block the main thread until all other threads are in sync.
   // When `dlopen` is called from a worker, the worker itself is blocked but
   // the operation its waiting on (on the main thread) can be async.
-  _emscripten_dlsync_threads__deps: ['_emscripten_proxy_dlsync', '$dlsyncThreadsAsync'],
+  _emscripten_dlsync_threads__deps: ['_emscripten_proxy_dlsync', '$dlsyncThreadsAsync',
+                                   '_emscripten_thread_hold_cleanups',
+                                   '_emscripten_thread_release_cleanups'],
   _emscripten_dlsync_threads__async: 'auto',
   _emscripten_dlsync_threads__proxy: 'sync',
   _emscripten_dlsync_threads: () => {
@@ -1288,11 +1311,20 @@ var LibraryPThread = {
     if (callingThread) {
       return dlsyncThreadsAsync();
     }
-    for (const ptr of Object.keys(PThread.pthreads)) {
-      const pthread_ptr = Number(ptr);
-      if (!PThread.finishedThreads.has(pthread_ptr)) {
-        __emscripten_proxy_dlsync(pthread_ptr);
+    // Each sync waits, and a wait on the main thread cleans up threads that
+    // have ended, which would free structs this list still names; hold that
+    // off until the list is done. A thread that has ended but isn't cleaned
+    // up yet refuses the proxy.
+    __emscripten_thread_hold_cleanups();
+    try {
+      for (const ptr of Object.keys(PThread.pthreads)) {
+        const pthread_ptr = Number(ptr);
+        if (ptr in PThread.pthreads && !PThread.finishedThreads.has(pthread_ptr)) {
+          __emscripten_proxy_dlsync(pthread_ptr);
+        }
       }
+    } finally {
+      __emscripten_thread_release_cleanups();
     }
   },
 #endif // MAIN_MODULE
diff --git a/system/lib/pthread/library_pthread.c b/system/lib/pthread/library_pthread.c
--- a/system/lib/pthread/library_pthread.c
+++ b/system/lib/pthread/library_pthread.c
@@ -10,6 +10,7 @@
 #include <assert.h>
 #include <pthread.h>
 #include <stdarg.h>
+#include <stdatomic.h>
 #include <threads.h>
 #include <unistd.h>
 
@@ -95,8 +96,56 @@ void emscripten_current_thread_process_queued_calls() {
   emscripten_proxy_execute_queue(emscripten_proxy_get_system_queue());
 }
 
+// Threads that ended without being joined on the main runtime thread, whose
+// Worker and memory only the main runtime thread can reclaim. They are linked
+// through `next`, which is free once a thread is off the thread list. A
+// detached thread adds itself after giving up its thread state, so adding
+// takes no lock and allocates nothing.
+static _Atomic(pthread_t) exited_threads;
+
+void _emscripten_thread_defer_cleanup(pthread_t thread) {
+  pthread_t head = atomic_load(&exited_threads);
+  do {
+    thread->next = head;
+  } while (!atomic_compare_exchange_weak(&exited_threads, &head, thread));
+  // Wake the main runtime thread in case it is blocked in
+  // `emscripten_futex_wait`, which reclaims them before returning.
+  _emscripten_thread_notify(emscripten_main_runtime_thread_id());
+}
+
+// Held while the main runtime thread walks a list of threads it took
+// earlier, where cleaning one up would free a struct the list still names.
+static int cleanup_holds;
+
+void _emscripten_thread_hold_cleanups(void) {
+  assert(emscripten_is_main_runtime_thread());
+  cleanup_holds++;
+}
+
+void _emscripten_thread_release_cleanups(void) {
+  assert(emscripten_is_main_runtime_thread());
+  assert(cleanup_holds > 0);
+  if (--cleanup_holds == 0) {
+    _emscripten_thread_run_deferred_cleanups();
+  }
+}
+
+void _emscripten_thread_run_deferred_cleanups(void) {
+  assert(emscripten_is_main_runtime_thread());
+  if (cleanup_holds) {
+    return;
+  }
+  pthread_t thread = atomic_exchange(&exited_threads, NULL);
+  while (thread) {
+    pthread_t next = thread->next;
+    _emscripten_thread_cleanup(thread);
+    thread = next;
+  }
+}
+
 void emscripten_main_thread_process_queued_calls() {
   assert(emscripten_is_main_runtime_thread());
+  _emscripten_thread_run_deferred_cleanups();
   emscripten_current_thread_process_queued_calls();
 }
 
diff --git a/system/lib/pthread/threading_internal.h b/system/lib/pthread/threading_internal.h
--- a/system/lib/pthread/threading_internal.h
+++ b/system/lib/pthread/threading_internal.h
@@ -63,6 +63,18 @@ void _emscripten_init_main_thread_js(void* tb);
 void _emscripten_thread_profiler_enable();
 void _emscripten_thread_cleanup(pthread_t thread);
 
+// Hands a thread that has ended to the main runtime thread for
+// `_emscripten_thread_cleanup`, from any other thread, even one that no longer
+// has a thread state of its own.
+void _emscripten_thread_defer_cleanup(pthread_t thread);
+// Runs the cleanups deferred so far, unless they are held. Main runtime
+// thread only.
+void _emscripten_thread_run_deferred_cleanups(void);
+// Hold deferred cleanups until a matching release, which runs them. Main
+// runtime thread only.
+void _emscripten_thread_hold_cleanups(void);
+void _emscripten_thread_release_cleanups(void);
+
 hidden void* _emscripten_tls_init(void);
 hidden void _emscripten_tls_free(void);
 
```

With this applied to 6.0.9:

```
round 1: 1608 bytes in use
round 2: 1608 bytes in use
round 3: 1608 bytes in use
round 4: 1608 bytes in use
round 5: 1608 bytes in use
```

Why not `emscripten_proxy_async()` from the exiting thread, which is what one
would reach for first: a detached thread calls the cleanup after
`__set_thread_state(NULL, ...)`
([pthread_create.c#L370](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/pthread/pthread_create.c#L370)),
so it has no `pthread_self()` any more, and proxying can block on the queue's
mutex (whose futex wait reads `pthread_self()`) and can allocate. Once the
thread is handed over, the main thread may free its block, stack included,
at any moment, so nothing after the hand-over may touch it either. A push onto
an atomic list, then a notify that reads only the main thread's struct, does
neither, the same way `_emscripten_thread_crashed()` avoids the proxying
queue ([emscripten_yield.c#L10-L19](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/pthread/emscripten_yield.c#L10-L19)).
The list is linked through `struct pthread`'s `next`, which is free once the
thread has left the thread list, so the struct layout and `struct_info`
don't change.

**Tests for the PR,** in the suite's format (also as
`emscripten-pthread-cleanup-blocked-main.tests.patch` beside this draft):

- `other.test_pthread_cleanup_blocked_main` runs rounds of detached threads,
  half of which join a child of their own, under a main thread that stays
  blocked, and fails if the heap or the Worker count grows.
- `core.test_pthread_dlsync_freed` (`@needs_dylink`, built like
  `test_pthread_dlopen` with `build_dlfcn_lib`/`prep_dlfcn_main`): a slow
  thread holds up its own sync, starting only once `_dlopen_proxying_queue`
  exists (the sync has begun), while a detached thread later in the list
  ends. The ended thread must not be freed before `dlopen()` returns, and
  must be freed by then.
- `core.test_pthread_dlsync_held`: the window inside one proxy. Another
  thread holds the dlopen queue's mutex until the main thread is waiting on
  it (musl's waiter count says so) in its sync of a thread that then ends.
  The same two conditions apply. With the skip but no hold, the thread is
  freed in that wait and the sync aborts on `thread->mailbox_refcount > 0`
  (debug libc) or reads garbage.

Both `dlsync` tests cover the synchronous sync of `dlopen()` on the main
thread. `dlsyncThreadsAsync`, the sync for `dlopen()` from a worker, gets
the same hold and skip but no test: its proxies are asynchronous, and the
only wait in its loop is for the queue's mutex and `malloc()`. Both tests
wait up to 300 ms for an ended thread to be freed. A thread exit that took
longer would let them pass without exercising the window; the positive
signals (the queue exists, the main thread is a waiter on its mutex) rule
out the other ways they could pass vacuously.

```diff
diff --git a/test/core/pthread/test_pthread_dlsync_freed.c b/test/core/pthread/test_pthread_dlsync_freed.c
new file mode 100644
--- /dev/null
+++ b/test/core/pthread/test_pthread_dlsync_freed.c
@@ -0,0 +1,150 @@
+// dlopen() on the main thread syncs the threads it knows of one at a time,
+// and each sync waits. A thread later in its list that ends during an
+// earlier thread's sync must not be cleaned up, and so freed, before the
+// sync reaches it; it is cleaned up as soon as the sync is done. Here a slow
+// thread holds up its own sync while a detached thread with a higher
+// address ends; if that thread is freed meanwhile, the slow thread fills its
+// block with 0xff before it lets its sync finish.
+
+#include <dlfcn.h>
+#include <emscripten/threading.h>
+#include <limits.h>
+#include <malloc.h>
+#include <math.h>
+#include <pthread.h>
+#include <stdio.h>
+#include <string.h>
+
+#define TIMEOUT_MS 5000
+// How long the freed block may take to appear, if it is freed at all.
+#define FREE_WAIT_MS 300
+// Long enough for a cleanup that has begun to free the block.
+#define FREE_DELAY_MS 50
+// More than a struct pthread takes.
+#define STRUCT_COVER 256
+
+// Created by dlopen()'s first sync of another thread.
+extern void *_Atomic _dlopen_proxying_queue;
+
+static pthread_t slow, victim;
+static size_t victim_size;
+static int roles_set, victim_go, victim_exiting, done;
+// Written by the slow thread before it lets its sync finish.
+static int held_sync, freed_during_sync, refilled;
+static const char *failure;
+
+static int load(int *flag) { return __atomic_load_n(flag, __ATOMIC_SEQ_CST); }
+
+static void raise_flag(int *flag) {
+  __atomic_store_n(flag, 1, __ATOMIC_SEQ_CST);
+  emscripten_futex_wake(flag, INT_MAX);
+}
+
+// Waits in futex waits, which also run the syncs dlopen() asks for.
+static void wait_for(int *flag) {
+  while (!load(flag))
+    emscripten_futex_wait(flag, 0, INFINITY);
+}
+
+static void spin_for_ms(double ms) {
+  double end = emscripten_get_now() + ms;
+  while (emscripten_get_now() < end)
+    ;
+}
+
+// A struct pthread starts with a pointer to itself, which cleaning it up
+// overwrites, just before freeing it.
+static int victim_freed(void) {
+  return *(void *volatile *)victim != (void *)victim;
+}
+
+static void refill_victim(void) {
+  spin_for_ms(FREE_DELAY_MS);
+  void *held[64];
+  int count = 0;
+  while (count < 64) {
+    char *block = malloc(victim_size);
+    if (block <= (char *)victim &&
+        (char *)victim + STRUCT_COVER <= block + victim_size) {
+      memset(block, 0xff, victim_size);
+      refilled = 1;
+      break;
+    }
+    held[count++] = block;
+  }
+  for (int i = 0; i < count; i++)
+    free(held[i]);
+}
+
+// Spins without a futex wait, so this thread's own sync stays pending.
+static void hold_up_sync(void) {
+  double end = emscripten_get_now() + TIMEOUT_MS;
+  while (_dlopen_proxying_queue == NULL) {
+    if (emscripten_get_now() > end) {
+      failure = "dlopen() never started syncing";
+      return;
+    }
+  }
+  held_sync = 1;
+  raise_flag(&victim_go);
+  while (!load(&victim_exiting))
+    ;
+  end = emscripten_get_now() + FREE_WAIT_MS;
+  while (!victim_freed() && emscripten_get_now() < end)
+    ;
+  if (victim_freed()) {
+    freed_during_sync = 1;
+    refill_victim();
+  }
+}
+
+static void *entry(void *arg) {
+  wait_for(&roles_set);
+  if (pthread_equal(pthread_self(), victim)) {
+    wait_for(&victim_go);
+    raise_flag(&victim_exiting);
+    return NULL;
+  }
+  hold_up_sync();
+  wait_for(&done);
+  return NULL;
+}
+
+int main() {
+  pthread_t a, b;
+  pthread_create(&a, NULL, entry, NULL);
+  pthread_create(&b, NULL, entry, NULL);
+  // dlopen() syncs threads in ascending order of their pthread_t, and the
+  // first sync creates the dlopen queue.
+  slow = a < b ? a : b;
+  victim = a < b ? b : a;
+  victim_size = malloc_usable_size((void *)victim);
+  pthread_detach(victim);
+  raise_flag(&roles_set);
+
+  int failures = 0;
+  if (dlopen("libside.so", RTLD_NOW) == NULL) {
+    printf("FAIL: dlopen: %s\n", dlerror());
+    failures++;
+  }
+  if (!victim_freed()) {
+    printf("FAIL: the victim wasn't cleaned up once dlopen() returned\n");
+    failures++;
+  }
+  raise_flag(&done);
+  pthread_join(slow, NULL);
+  if (failure != NULL) {
+    printf("FAIL: %s\n", failure);
+    failures++;
+  } else if (!held_sync) {
+    printf("FAIL: the sync wasn't held up while the victim ended\n");
+    failures++;
+  }
+  if (freed_during_sync) {
+    printf("FAIL: the victim was freed while dlopen() was syncing%s\n",
+           refilled ? ", and its block reused" : "");
+    failures++;
+  }
+  printf("%d failures\n", failures);
+  return failures != 0;
+}
diff --git a/test/core/pthread/test_pthread_dlsync_held.c b/test/core/pthread/test_pthread_dlsync_held.c
new file mode 100644
--- /dev/null
+++ b/test/core/pthread/test_pthread_dlsync_held.c
@@ -0,0 +1,182 @@
+// dlopen() on the main thread syncs the threads it knows of one at a time.
+// Proxying the sync to a thread can itself wait, here on the dlopen queue's
+// mutex, which another thread holds; a thread that ends meanwhile must not
+// be cleaned up, and so freed, while the sync is about to reach its struct.
+// It is cleaned up as soon as the sync is done.
+
+#include <dlfcn.h>
+#include <emscripten/threading.h>
+#include <limits.h>
+#include <malloc.h>
+#include <math.h>
+#include <pthread.h>
+#include <stdio.h>
+#include <string.h>
+
+#define TIMEOUT_MS 5000
+// How long the freed block may take to appear, if it is freed at all.
+#define FREE_WAIT_MS 300
+// Long enough for a cleanup that has begun to free the block.
+#define FREE_DELAY_MS 50
+// More than a struct pthread takes.
+#define STRUCT_COVER 256
+
+// Created by dlopen()'s first sync of another thread; it starts with the
+// mutex that proxying a sync takes.
+extern void *_Atomic _dlopen_proxying_queue;
+
+static pthread_t victim, holder;
+static size_t victim_size;
+static int roles_set, first_loaded, victim_spinning, locked, victim_go,
+    victim_exiting, done;
+// Written by the holder before it lets the sync go on.
+static int saw_waiter, freed_during_sync, refilled;
+static const char *failure;
+
+static int load(int *flag) { return __atomic_load_n(flag, __ATOMIC_SEQ_CST); }
+
+static void raise_flag(int *flag) {
+  __atomic_store_n(flag, 1, __ATOMIC_SEQ_CST);
+  emscripten_futex_wake(flag, INT_MAX);
+}
+
+// Waits in futex waits, which also run the syncs dlopen() asks for.
+static void wait_for(int *flag) {
+  while (!load(flag))
+    emscripten_futex_wait(flag, 0, INFINITY);
+}
+
+// Spins without a futex wait, so this thread never takes the dlopen
+// queue's mutex meanwhile.
+static int spin_for(int *flag) {
+  double end = emscripten_get_now() + TIMEOUT_MS;
+  while (!load(flag))
+    if (emscripten_get_now() > end)
+      return 0;
+  return 1;
+}
+
+static void spin_for_ms(double ms) {
+  double end = emscripten_get_now() + ms;
+  while (emscripten_get_now() < end)
+    ;
+}
+
+// A struct pthread starts with a pointer to itself, which cleaning it up
+// overwrites, just before freeing it.
+static int victim_freed(void) {
+  return *(void *volatile *)victim != (void *)victim;
+}
+
+static void refill_victim(void) {
+  spin_for_ms(FREE_DELAY_MS);
+  void *held[64];
+  int count = 0;
+  while (count < 64) {
+    char *block = malloc(victim_size);
+    if (block <= (char *)victim &&
+        (char *)victim + STRUCT_COVER <= block + victim_size) {
+      memset(block, 0xff, victim_size);
+      refilled = 1;
+      break;
+    }
+    held[count++] = block;
+  }
+  for (int i = 0; i < count; i++)
+    free(held[i]);
+}
+
+static void hold_queue(void) {
+  if (!spin_for(&victim_spinning)) {
+    failure = "the victim never started spinning";
+    return;
+  }
+  pthread_mutex_t *mutex = (pthread_mutex_t *)_dlopen_proxying_queue;
+  pthread_mutex_lock(mutex);
+  raise_flag(&locked);
+  // musl counts a mutex's waiters in its third int; the main thread is the
+  // only one that can wait on this one now.
+  double end = emscripten_get_now() + TIMEOUT_MS;
+  while (((volatile int *)mutex)[2] == 0) {
+    if (emscripten_get_now() > end) {
+      failure = "dlopen() never waited on the queue";
+      pthread_mutex_unlock(mutex);
+      return;
+    }
+  }
+  saw_waiter = 1;
+  raise_flag(&victim_go);
+  spin_for(&victim_exiting);
+  end = emscripten_get_now() + FREE_WAIT_MS;
+  while (!victim_freed() && emscripten_get_now() < end)
+    ;
+  if (victim_freed()) {
+    freed_during_sync = 1;
+    refill_victim();
+  }
+  pthread_mutex_unlock(mutex);
+}
+
+static void *entry(void *arg) {
+  wait_for(&roles_set);
+  wait_for(&first_loaded);
+  if (pthread_equal(pthread_self(), victim)) {
+    raise_flag(&victim_spinning);
+    spin_for(&victim_go);
+    raise_flag(&victim_exiting);
+    return NULL;
+  }
+  hold_queue();
+  wait_for(&done);
+  return NULL;
+}
+
+int main() {
+  pthread_t a, b;
+  pthread_create(&a, NULL, entry, NULL);
+  pthread_create(&b, NULL, entry, NULL);
+  // dlopen() syncs threads in ascending order of their pthread_t: the
+  // victim's sync must be the one that waits.
+  victim = a < b ? a : b;
+  holder = a < b ? b : a;
+  victim_size = malloc_usable_size((void *)victim);
+  pthread_detach(victim);
+  raise_flag(&roles_set);
+
+  int failures = 0;
+  // The first load creates the dlopen queue.
+  if (dlopen("libside.so", RTLD_NOW) == NULL) {
+    printf("FAIL: dlopen: %s\n", dlerror());
+    return 1;
+  }
+  raise_flag(&first_loaded);
+  if (!spin_for(&locked)) {
+    printf("FAIL: the holder never took the queue's mutex: %s\n",
+           failure ? failure : "?");
+    return 1;
+  }
+  if (dlopen("libside2.so", RTLD_NOW) == NULL) {
+    printf("FAIL: dlopen: %s\n", dlerror());
+    failures++;
+  }
+  if (!victim_freed()) {
+    printf("FAIL: the victim wasn't cleaned up once dlopen() returned\n");
+    failures++;
+  }
+  raise_flag(&done);
+  pthread_join(holder, NULL);
+  if (failure != NULL) {
+    printf("FAIL: %s\n", failure);
+    failures++;
+  } else if (!saw_waiter) {
+    printf("FAIL: dlopen() didn't wait on the queue while the victim ended\n");
+    failures++;
+  }
+  if (freed_during_sync) {
+    printf("FAIL: the victim was freed while dlopen() was syncing%s\n",
+           refilled ? ", and its block reused" : "");
+    failures++;
+  }
+  printf("%d failures\n", failures);
+  return failures != 0;
+}
diff --git a/test/core/pthread/test_pthread_dlsync_side.c b/test/core/pthread/test_pthread_dlsync_side.c
new file mode 100644
--- /dev/null
+++ b/test/core/pthread/test_pthread_dlsync_side.c
@@ -0,0 +1 @@
+int side_value() { return 42; }
diff --git a/test/pthread/test_pthread_cleanup_blocked_main.c b/test/pthread/test_pthread_cleanup_blocked_main.c
new file mode 100644
--- /dev/null
+++ b/test/pthread/test_pthread_cleanup_blocked_main.c
@@ -0,0 +1,98 @@
+// Threads that end without being joined on the main thread (detached ones,
+// and ones another thread joins) are cleaned up while the main thread stays
+// blocked: their memory is freed and their Workers go back to the pool
+// without the main thread returning to its event loop.
+
+#include <emscripten/em_asm.h>
+#include <emscripten/threading.h>
+#include <limits.h>
+#include <malloc.h>
+#include <pthread.h>
+#include <stdio.h>
+
+#define ROUNDS 8
+// Each round's threads: half end detached, half join a child of their own
+// first, so a round runs up to 1.5 * THREADS threads at once.
+#define THREADS 4
+#define AT_ONCE (THREADS + THREADS / 2)
+#define STACK_SIZE (256 * 1024)
+
+static pthread_attr_t attr;
+static int finished;
+
+static int worker_count() {
+  return EM_ASM_INT({
+    return PThread.unusedWorkers.length + Object.keys(PThread.pthreads).length;
+  });
+}
+
+static void* finish(void* arg) {
+  __atomic_fetch_add(&finished, 1, __ATOMIC_SEQ_CST);
+  emscripten_futex_wake(&finished, INT_MAX);
+  return NULL;
+}
+
+static void* join_child(void* arg) {
+  pthread_t child;
+  if (pthread_create(&child, &attr, finish, NULL) == 0) {
+    pthread_join(child, NULL);
+  }
+  return finish(NULL);
+}
+
+// Blocks without returning to the event loop.
+static void block_for(double ms) {
+  static int never;
+  double end = emscripten_get_now() + ms;
+  for (double left = ms; left > 0; left = end - emscripten_get_now()) {
+    emscripten_futex_wait(&never, 0, left);
+  }
+}
+
+static size_t in_use() { return mallinfo().uordblks; }
+
+static void run_round() {
+  int target = __atomic_load_n(&finished, __ATOMIC_SEQ_CST) + AT_ONCE;
+  for (int i = 0; i < THREADS; i++) {
+    pthread_t thread;
+    pthread_create(&thread, &attr, i % 2 ? join_child : finish, NULL);
+    pthread_detach(thread);
+  }
+  for (int now; (now = __atomic_load_n(&finished, __ATOMIC_SEQ_CST)) < target;) {
+    emscripten_futex_wait(&finished, now, 1000);
+  }
+}
+
+int main() {
+  pthread_attr_init(&attr);
+  pthread_attr_setstacksize(&attr, STACK_SIZE);
+  int max_workers = worker_count() + AT_ONCE;
+
+  // One round warms up whatever the runtime allocates once.
+  run_round();
+  block_for(200);
+  size_t baseline = in_use();
+  int failures = 0;
+  for (int round = 1; round < ROUNDS; round++) {
+    run_round();
+    double deadline = emscripten_get_now() + 5000;
+    while (in_use() > baseline + STACK_SIZE / 2 && emscripten_get_now() < deadline) {
+      block_for(5);
+    }
+    size_t used = in_use();
+    int workers = worker_count();
+    printf("round %d: %zu bytes in use (baseline %zu), %d workers\n", round, used, baseline, workers);
+    if (used > baseline + STACK_SIZE / 2) {
+      printf("FAIL: round %d's threads still hold memory\n", round);
+      failures++;
+    }
+    if (workers > max_workers) {
+      printf("FAIL: %d workers, more than the %d to start with plus %d threads at once\n", workers, max_workers - AT_ONCE, AT_ONCE);
+      failures++;
+    }
+  }
+  if (failures == 0) {
+    printf("done\n");
+  }
+  return failures != 0;
+}
diff --git a/test/test_core.py b/test/test_core.py
--- a/test/test_core.py
+++ b/test/test_core.py
@@ -9414,6 +9414,25 @@ NODEFS is no longer included by default; build with -lnodefs.js
                  ['side module ctor', 'done\n', 'side module atexit'],
                  assert_all=True, cflags=args)
 
+  @needs_dylink
+  @requires_pthreads
+  def test_pthread_dlsync_freed(self):
+    self.cflags += ['-Wno-experimental', '-pthread']
+    self.build_dlfcn_lib(test_file('core/pthread/test_pthread_dlsync_side.c'))
+    self.cflags += ['--embed-file', 'libside.so@libside.so']
+    self.prep_dlfcn_main()
+    self.do_runf('core/pthread/test_pthread_dlsync_freed.c', '0 failures\n')
+
+  @needs_dylink
+  @requires_pthreads
+  def test_pthread_dlsync_held(self):
+    self.cflags += ['-Wno-experimental', '-pthread']
+    self.build_dlfcn_lib(test_file('core/pthread/test_pthread_dlsync_side.c'))
+    shutil.copy('libside.so', 'libside2.so')
+    self.cflags += ['--embed-file', 'libside.so@libside.so', '--embed-file', 'libside2.so@libside2.so']
+    self.prep_dlfcn_main()
+    self.do_runf('core/pthread/test_pthread_dlsync_held.c', '0 failures\n')
+
   @needs_dylink
   @requires_pthreads
   @flaky('https://github.com/emscripten-core/emscripten/issues/18887')
diff --git a/test/test_other.py b/test/test_other.py
--- a/test/test_other.py
+++ b/test/test_other.py
@@ -13609,6 +13609,10 @@ void foo() {}
   def test_pthread_sigmask(self, args):
     self.do_runf('pthread/test_pthread_sigmask.c', 'done\n', cflags=args)
 
+  @requires_pthreads
+  def test_pthread_cleanup_blocked_main(self):
+    self.do_runf('pthread/test_pthread_cleanup_blocked_main.c', 'done\n', cflags=['-pthread'])
+
   # Tests memory growth in pthreads mode, but still on the main thread.
   @crossplatform
   @requires_pthreads
```

---

## Notes for the user

- **How the fix was tested.**
  - The test case above, with and without the patch, on nixpkgs' 6.0.9.
  - Our `checks.emscripten-fixes` runs a stronger version
    (`modules/emscripten/checks/fixes/thread-cleanup.c`): eight rounds of
    detached threads, half of which join a child of their own first (so the
    join-from-another-thread path is covered too, and the children's creation
    is proxied to the blocked main thread), on our `MAIN_MODULE=1` + WasmFS
    test link with assertions. Unpatched: +1.6 MiB and +6 Workers per round.
    Patched: in-use heap flat at 9 KiB, never more Workers than threads alive
    at once.
  - `checks.emscripten-fixes` also runs `dlsync-freed.c` and
    `dlsync-held.c`, the check forms of the two `dlsync` tests. With the
    skip but no hold, `dlsync-freed.c` fails (the thread is freed during the
    sync) and `dlsync-held.c` aborts on `thread->mailbox_refcount > 0`. With
    the hold both pass.
  - The suite-format tests, run with Emscripten's runner:

    | Tree | `cleanup_blocked_main` | `dlsync_freed` | `dlsync_held` |
    | --- | --- | --- | --- |
    | stock 6.0.9 | FAIL | FAIL | FAIL |
    | this change, first version (no skip, no hold) | ok | FAIL | FAIL |
    | with the skip, no hold | ok | FAIL | FAIL |
    | this change | ok | ok (5 of 5 at `-O0` and `-O2`) | ok (5 of 5 at `-O0` and `-O2`) |

  - GLib's test suite (`checks.glib-tests`: 277 must-pass tests, 0 failing,
    unchanged), and the runtime spike's `thread-exit-blocked` scenario: the
    heap stays at 0.18 MiB across five rounds where it used to grow 4 MiB a
    round (1 MiB stacks), and no Worker is created once idle ones exist.
  - Emscripten's own test runner on 6.0.9 with and without the patch (and
    0015), a 198-test selection under Node (`core2.test_pthread_*`,
    `other.test_pthread_*`, `core2`/`other` tests matching `*thread*` and
    `*proxy*`, and the pthread dylink tests): identical results, 163 passing
    and the same 31 failing or erroring in both. Those 31 fail on this
    environment, not the patch: nixpkgs' LLVM 22 rejects
    `-Wno-unused-but-set-global`, Closure warns under `-Werror`, ten need
    Node 26, three need `emcmake`, which the copied tree lacked, and
    `other.test_pthread_lsan_leak` (both variants) traps with "memory access
    out of bounds" either way.
- **Behaviour when the main thread is idle** is unchanged: the message still
  arrives and its handler drains the list (which may already be empty, if the
  main thread processed its queued calls since). The `thread` field of the
  message is gone; nothing else read it.
- **Side effects to mention in the PR.**
  - Each unjoined exit now also notifies the main thread, so a main thread in
    `emscripten_futex_wait()` returns early (`-EINTR`) once per such exit, as
    it already does whenever work is proxied to it. Callers loop on spurious
    wakeups anyway.
  - The cleanup can now run inside any blocking call on the main thread,
    as a proxied call can, and `returnWorkerToPool()` already defers its
    `free()` to the end for that reason. Unlike a proxied call, though, it
    frees a `struct pthread` that Emscripten's own JavaScript may be
    iterating over: `_emscripten_dlsync_threads` and `dlsyncThreadsAsync`
    take `Object.keys(PThread.pthreads)` and then proxy to each thread in
    turn, and each proxy can wait, even between checking the list and
    touching the thread (`emscripten_thread_mailbox_ref()`). A thread freed
    there would be synced through its freed struct, which can corrupt
    whatever reuses the memory or hang `dlopen()`. The fix holds cleanups
    for the length of both loops and runs them at the end.
  - Pre-existing, `MAIN_MODULE` only, made more likely: a joinable thread
    posts `CMD_MARK_AS_FINISHED` when it exits, and a join on the main thread
    cleans it up at once, possibly before that message arrives. The late
    message can then mark a new, running thread at the same address
    finished, and `dlopen()`'s sync skips it. With this patch, joins on
    other threads clean up early too. That bug and its fix are a separate
    draft, `emscripten-pthread-finished-mark-reused.md` (patch 0015 here),
    which this PR should link.
- **Duplicate search.** `gh` searches of the repository for
  "_emscripten_thread_cleanup", "CMD_CLEANUP_THREAD", "cleanupThread",
  "returnWorkerToPool", "detached thread leak", "detached pthread memory
  leak", "thread cleanup main thread blocked" and "pthread exit event loop
  leak worker" turned up:
  - #16763 ("pthread_create doesn't use in a thread from the thread pool",
    closed by its reporter in 2022): this bug, diagnosed by sbc100 as above,
    with workarounds only.
  - #8201 / #8286 (2019): detached threads weren't returned to the pool at
    all; fixed by returning them through the event loop, which is the path
    this changes.
  - #24711, #27501, #15605: other changes to the same cleanup code; none
    about a blocked main thread.
- **Tip-of-tree.** Checked read-only through the GitHub API on 2026-10-01:
  `library_pthread.c`, `pthread_create.c` and `pthread_join.c` are unchanged
  between 6.0.9 and `main` (04df3de, 147 commits later). `libpthread.js`
  changed elsewhere (shared-WasmGC removal, a `PROXY_SYNC_ASYNC` fix), and
  `_emscripten_yield()` now returns `void`; the patch applies to `main` with
  offsets only (`patch --dry-run`). 6.0.10 changed only other parts of
  `libpthread.js`. `main` wasn't rebuilt.
- ibus-web carries this fix as
  `modules/emscripten/patches/0014-pthread-cleanup-blocked-main.patch`.
