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
loop. 48 lines added, 2 removed.

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
 
@@ -95,8 +96,36 @@ void emscripten_current_thread_process_queued_calls() {
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
+void _emscripten_thread_run_deferred_cleanups(void) {
+  assert(emscripten_is_main_runtime_thread());
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
@@ -63,6 +63,13 @@ void _emscripten_init_main_thread_js(void* tb);
 void _emscripten_thread_profiler_enable();
 void _emscripten_thread_cleanup(pthread_t thread);
 
+// Hands a thread that has ended to the main runtime thread for
+// `_emscripten_thread_cleanup`, from any other thread, even one that no longer
+// has a thread state of its own.
+void _emscripten_thread_defer_cleanup(pthread_t thread);
+// Runs the cleanups deferred so far. Main runtime thread only.
+void _emscripten_thread_run_deferred_cleanups(void);
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

---

## Notes for the user

- **How the fix was tested.**
  - The test case above, with and without the patch, on nixpkgs' 6.0.9.
  - Our `checks.emscripten-fixes` runs a stronger version
    (`modules/emscripten/checks/fixes/thread-cleanup.c`): eight rounds of
    detached threads, half of which join a child of their own first (so the
    join-from-another-thread path is covered too, and the children's creation
    is proxied to the blocked main thread), on our `MAIN_MODULE=2` + WasmFS
    test link with assertions. Unpatched: +1.6 MiB and +6 Workers per round.
    Patched: in-use heap flat at 9 KiB, never more Workers than threads alive
    at once.
  - GLib's test suite (`checks.glib-tests`: 277 must-pass tests, 0 failing,
    unchanged), and the runtime spike's `thread-exit-blocked` scenario: the
    heap stays at 0.18 MiB across five rounds where it used to grow 4 MiB a
    round (1 MiB stacks), and no Worker is created once idle ones exist.
  - Emscripten's own test runner on 6.0.9 with and without the patch, a
    198-test selection under Node (`core2.test_pthread_*`,
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
    like a proxied call can. `returnWorkerToPool()` already defers its
    `free()` to the end for that reason.
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
