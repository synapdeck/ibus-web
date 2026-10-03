# pthreads + dynamic linking: a late "finished" mark makes dlopen() skip a running thread

**Posted: don't post again.** Filed as
[#27841](https://github.com/emscripten-core/emscripten/issues/27841)
(2026-10-01), with the fix and its test as PR
[#27846](https://github.com/emscripten-core/emscripten/pull/27846) ("[pthread]
Don't let a stale "finished" message mark a reused thread in dlopen sync",
open, no review yet).

Checked against `main` 5977ecc (2026-10-02): the message handler,
`markAsFinished()`, `cleanupThread()` and the dlsync loops are unchanged, and
0015 applies there alone with offsets only. With Emscripten's runner, emsdk's
toolchain for `main` (`test/emsdk_version.txt` dbaebb43: clang 24.0.0git
d3e9891b, Binaryen 133) and Node 24.21.0,
`core2.test_pthread_dlsync_reused` fails on `main` ("table index is out of
bounds") and on `main` with 0014 alone, and passes on `main` with 0015 alone
and with the whole stack (logs: `task14-upstream-main-*.log`).

**Draft: new issue, with a PR.** Separate from
`emscripten-pthread-cleanup-blocked-main.md` on purpose: this bug is in stock
6.0.9 with nothing else applied, the fix is 15 lines and applies to `main`
with or without that other change, and it can be reviewed and tested on its
own. The other fix makes the bug easier to hit, which its PR should mention
with a link to this one.

## Issue title

dlopen() skips a running thread whose pthread_t was reused from a just-joined thread ("table index is out of bounds")

## Issue body

---

With `-pthread -sMAIN_MODULE`, a joinable thread posts
`CMD_MARK_AS_FINISHED` to the main thread as it exits, and the main thread
adds it to `PThread.finishedThreads`, which `dlopen()`'s sync skips. But a
join cleans the thread up as soon as it returns, removing it from that set,
while the message may still be queued. If a new thread is created at the
same address in the meantime (malloc readily hands back the block it just
freed), the late message marks the **new, running** thread finished. Every
later `dlopen()` skips it, and when it calls into a module loaded after it
started, it traps with "table index is out of bounds" (or "null function or
function signature mismatch").

It takes no unusual code: join a thread on the main thread, create another
one before returning to the event loop, then `dlopen()` a module the new
thread uses. Joins on other threads hit it too, as soon as their cleanup can
run before the main thread's event loop does.

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

**Test case** (`side.c` and `reused.c`):

```c
int side_value(void) { return 42; }
```

```c
#include <dlfcn.h>
#include <emscripten/eventloop.h>
#include <emscripten/threading.h>
#include <limits.h>
#include <math.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>

static pthread_t waiter;
static int go;
static int (*value)(void);

static void *quit(void *arg) { return NULL; }

static void *wait_then_call(void *arg) {
  while (__atomic_load_n(&go, __ATOMIC_SEQ_CST) == 0)
    emscripten_futex_wait(&go, 0, INFINITY);
  printf("thread: side_value() = %d\n", value());
  return NULL;
}

static void load_and_call(void *arg) {
  void *side = dlopen("/side.wasm", RTLD_NOW);
  value = (int (*)(void))dlsym(side, "side_value");
  __atomic_store_n(&go, 1, __ATOMIC_SEQ_CST);
  emscripten_futex_wake(&go, INT_MAX);
  pthread_join(waiter, NULL);
  exit(0);
}

int main(void) {
  pthread_t joined;
  pthread_create(&joined, NULL, quit, NULL);
  pthread_join(joined, NULL);
  pthread_create(&waiter, NULL, wait_then_call, NULL);
  printf("same pthread_t: %s\n", pthread_equal(waiter, joined) ? "yes" : "no");
  emscripten_set_timeout(load_and_call, 100, NULL);
  return 0;
}
```

**Failing command line in full:**

```
$ emcc -O2 -pthread -sSIDE_MODULE side.c -o side.wasm
$ emcc -O2 -pthread -sMAIN_MODULE -sEXIT_RUNTIME --embed-file side.wasm@/side.wasm reused.c -o reused.js
$ node reused.js
same pthread_t: yes
worker sent an error! undefined:undefined: table index is out of bounds
node:internal/event_target:1136
  process.nextTick(() => { throw err; });
                           ^

RuntimeError: table index is out of bounds
    at wasm://wasm/002507ea:wasm-function[137]:0xc82d
    at invokeEntryPoint (reused.js:1:19002)
    at handleMessage (reused.js:1:4574)
    at MessagePort.<anonymous> (reused.js:1:3359)
    at [nodejs.internal.kHybridDispatch] (node:internal/event_target:856:20)
    at MessagePort.<anonymous> (node:internal/per_context/messageport:23:28)

Node.js v24.20.0
[exit status 1]
```

<details>
<summary>Full compile and link output with <code>-v</code> appended (cache and scratch paths shortened)</summary>

```
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/clang -target wasm32-unknown-emscripten -fignore-exceptions -fPIC -fvisibility=default -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr --sysroot=$EM_CACHE/sysroot -resource-dir=/nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter$EM_CACHE/sysroot/include -iwithsysroot/include/c++/v1 -D__EMSCRIPTEN_SHARED_MEMORY__=1 -Xclang -iwithsysroot/include/fakesdl -Xclang -iwithsysroot/include/compat -O2 -pthread -v -c side.c -o /tmp/emscripten_temp_r3zc54u2/side.o
clang version 22.1.8
Target: wasm32-unknown-emscripten
Thread model: posix
InstalledDir: /nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin
 (in-process)
 "/nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin/clang-22" -cc1 -triple wasm32-unknown-emscripten -O2 -emit-obj -disable-free -clear-ast-before-backend -disable-llvm-verifier -discard-value-names -main-file-name side.c -mrelocation-model pic -pic-level 2 -mframe-pointer=none -ffp-contract=on -fno-rounding-math -mconstructor-aliases -target-feature +atomics -target-feature +bulk-memory -target-feature +mutable-globals -target-feature +sign-ext -target-feature +mutable-globals -target-cpu generic -debugger-tuning=gdb -fdebug-compilation-dir=. -v -fcoverage-compilation-dir=. -resource-dir /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter $EM_CACHE/sysroot/include -iwithsysroot /include/c++/v1 -D __EMSCRIPTEN_SHARED_MEMORY__=1 -isysroot $EM_CACHE/sysroot -internal-isystem /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/include -internal-isystem $EM_CACHE/sysroot/include/wasm32-emscripten -internal-isystem $EM_CACHE/sysroot/include -ferror-limit 19 -fvisibility=default -pthread -fgnuc-version=4.2.1 -fskip-odr-check-in-gmf -fignore-exceptions -vectorize-loops -vectorize-slp -iwithsysroot/include/fakesdl -iwithsysroot/include/compat -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr -o /tmp/emscripten_temp_r3zc54u2/side.o -x c side.c
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
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/wasm-ld -o side.wasm -Bdynamic --import-memory --shared-memory --strip-debug --export=__wasm_call_ctors --export=_emscripten_tls_init --export-if-defined=__start_em_asm --export-if-defined=__stop_em_asm --export-if-defined=__start_em_lib_deps --export-if-defined=__stop_em_lib_deps --export-if-defined=__start_em_js --export-if-defined=__stop_em_js --export-if-defined=main --export-if-defined=__main_argc_argv --unresolved-symbols=import-dynamic -shared --no-export-dynamic --no-stack-first /tmp/emscripten_temp_r3zc54u2/side.o -L$EM_CACHE/sysroot/lib/wasm32-emscripten/pic -L/nix/store/03iyrnrsxnbc64y6r62irmlbnbap5ya2-emscripten-6.0.9/share/emscripten/src/lib $EM_CACHE/sysroot/lib/wasm32-emscripten/pic/crtbegin-mt.o -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr
wasm-ld: warning: creating shared libraries, with -shared, is not yet stable
wasm-ld: warning: dynamic imports are not yet stable (--unresolved-symbols=import-dynamic)
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/wasm-ld -o side.wasm -Bdynamic --import-memory --shared-memory --strip-debug --export=__wasm_call_ctors --export=_emscripten_tls_init --export-if-defined=__start_em_asm --export-if-defined=__stop_em_asm --export-if-defined=__start_em_lib_deps --export-if-defined=__stop_em_lib_deps --export-if-defined=__start_em_js --export-if-defined=__stop_em_js --export-if-defined=main --export-if-defined=__main_argc_argv --unresolved-symbols=import-dynamic -shared --no-stack-first /tmp/emscripten_temp_r3zc54u2/side.o -L$EM_CACHE/sysroot/lib/wasm32-emscripten/pic -L/nix/store/03iyrnrsxnbc64y6r62irmlbnbap5ya2-emscripten-6.0.9/share/emscripten/src/lib $EM_CACHE/sysroot/lib/wasm32-emscripten/pic/crtbegin-mt.o -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr
wasm-ld: warning: creating shared libraries, with -shared, is not yet stable
wasm-ld: warning: dynamic imports are not yet stable (--unresolved-symbols=import-dynamic)
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/llvm-objcopy side.wasm side.wasm '--remove-section=llvm.func_attr.annotate.*' --remove-section=producers --remove-section=name '--remove-section=.debug*'
 /nix/store/nd1279k2zlbp23gfqcl0qp5xk40xlxr8-binaryen-132/bin/wasm-opt --strip-target-features --post-emscripten --pass-arg=post-emscripten-side-module -O2 --low-memory-unused --pass-arg=directize-initial-contents-immutable side.wasm -o side.wasm --mvp-features --enable-threads --enable-bulk-memory --enable-bulk-memory-opt --enable-call-indirect-overlong --enable-multivalue --enable-mutable-globals --enable-nontrapping-float-to-int --enable-reference-types --enable-sign-ext
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/clang -target wasm32-unknown-emscripten -fignore-exceptions -fPIC -fvisibility=default -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr --sysroot=$EM_CACHE/sysroot -resource-dir=/nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter$EM_CACHE/sysroot/include -iwithsysroot/include/c++/v1 -D__EMSCRIPTEN_SHARED_MEMORY__=1 -Xclang -iwithsysroot/include/fakesdl -Xclang -iwithsysroot/include/compat -O2 -pthread -v -c reused.c -o /tmp/emscripten_temp_r3jihygn/reused.o
clang version 22.1.8
Target: wasm32-unknown-emscripten
Thread model: posix
InstalledDir: /nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin
 (in-process)
 "/nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin/clang-22" -cc1 -triple wasm32-unknown-emscripten -O2 -emit-obj -disable-free -clear-ast-before-backend -disable-llvm-verifier -discard-value-names -main-file-name reused.c -mrelocation-model pic -pic-level 2 -mframe-pointer=none -ffp-contract=on -fno-rounding-math -mconstructor-aliases -target-feature +atomics -target-feature +bulk-memory -target-feature +mutable-globals -target-feature +sign-ext -target-feature +mutable-globals -target-cpu generic -debugger-tuning=gdb -fdebug-compilation-dir=. -v -fcoverage-compilation-dir=. -resource-dir /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter $EM_CACHE/sysroot/include -iwithsysroot /include/c++/v1 -D __EMSCRIPTEN_SHARED_MEMORY__=1 -isysroot $EM_CACHE/sysroot -internal-isystem /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/include -internal-isystem $EM_CACHE/sysroot/include/wasm32-emscripten -internal-isystem $EM_CACHE/sysroot/include -ferror-limit 19 -fvisibility=default -pthread -fgnuc-version=4.2.1 -fskip-odr-check-in-gmf -fignore-exceptions -vectorize-loops -vectorize-slp -iwithsysroot/include/fakesdl -iwithsysroot/include/compat -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr -o /tmp/emscripten_temp_r3jihygn/reused.o -x c reused.c
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
emcc: warning: dynamic linking + pthreads is experimental [-Wexperimental]
 /nix/store/03iyrnrsxnbc64y6r62irmlbnbap5ya2-emscripten-6.0.9/share/emscripten/tools/file_packager reused.data --from-emcc --embed side.wasm@/side.wasm --obj-output=/tmp/emscripten_temp_r3jihygn/embedded_files.o
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/wasm-ld -o reused.wasm --export-if-defined=setThrew --export-if-defined=_emscripten_stack_restore --export-if-defined=emscripten_stack_get_current --export-if-defined=_emscripten_find_dylib --export-if-defined=_emscripten_stack_alloc --export-if-defined=emscripten_get_sbrk_ptr --export-if-defined=__heap_base --export-if-defined=calloc --export-if-defined=_emscripten_thread_init --export-if-defined=_emscripten_thread_free_data --export-if-defined=pthread_self --export-if-defined=__set_thread_state --export-if-defined=emscripten_stack_set_limits --export-if-defined=_emscripten_thread_exit --export-if-defined=_emscripten_tempret_get --export-if-defined=_emscripten_tempret_set --export-if-defined=strerror --export-if-defined=htons --export-if-defined=ntohs --export-if-defined=malloc --export-if-defined=htonl --export-if-defined=_emscripten_timeout --export-if-defined=realloc --export-if-defined=_emscripten_run_js_on_main_thread --export-if-defined=_emscripten_run_callback_on_thread --export-if-defined=free --export-if-defined=fileno --export-if-defined=emscripten_builtin_memalign --export-if-defined=__dl_seterr --export-if-defined=memcmp --export-if-defined=memcpy --export-if-defined=_emscripten_run_js_on_main_thread_done --export-if-defined=_emscripten_proxy_dlsync_async --export-if-defined=_emscripten_proxy_dlsync --export-if-defined=_emscripten_check_mailbox /tmp/tmpjf8ma_mylibemscripten_js_symbols.so -Bdynamic --import-memory --shared-memory --strip-debug --export=__stack_pointer --export=_emscripten_stack_alloc --export=_emscripten_thread_free_data --export=_emscripten_thread_crashed --export=_emscripten_dlsync_self --export=_emscripten_dlsync_self_async --export=_emscripten_proxy_dlsync --export=_emscripten_proxy_dlsync_async --export=__dl_seterr --export=__funcs_on_exit --export=__wasm_call_ctors --export=_emscripten_tls_init --export=setThrew --export=_emscripten_stack_restore --export=emscripten_stack_get_current --export=_emscripten_find_dylib --export=emscripten_get_sbrk_ptr --export=__heap_base --export=calloc --export=_emscripten_thread_init --export=pthread_self --export=__set_thread_state --export=emscripten_stack_set_limits --export=_emscripten_thread_exit --export=_emscripten_tempret_get --export=_emscripten_tempret_set --export=strerror --export=htons --export=ntohs --export=malloc --export=htonl --export=_emscripten_timeout --export=realloc --export=_emscripten_run_js_on_main_thread --export=_emscripten_run_callback_on_thread --export=free --export=fileno --export=emscripten_builtin_memalign --export=memcmp --export=memcpy --export=_emscripten_run_js_on_main_thread_done --export=_emscripten_check_mailbox --export-if-defined=__start_em_asm --export-if-defined=__stop_em_asm --export-if-defined=__start_em_lib_deps --export-if-defined=__stop_em_lib_deps --export-if-defined=__start_em_js --export-if-defined=__stop_em_js --export-if-defined=main --export-if-defined=__main_argc_argv --export-if-defined=fflush --unresolved-symbols=import-dynamic --export-table --growable-table -z stack-size=65536 --no-growable-memory --initial-memory=16777216 --no-entry --no-stack-first --table-base=1 --global-base=1024 /tmp/emscripten_temp_r3jihygn/reused.o -L$EM_CACHE/sysroot/lib/wasm32-emscripten/pic -L/nix/store/03iyrnrsxnbc64y6r62irmlbnbap5ya2-emscripten-6.0.9/share/emscripten/src/lib /tmp/emscripten_temp_r3jihygn/embedded_files.o $EM_CACHE/sysroot/lib/wasm32-emscripten/pic/crtbegin-mt.o -lGL-mt-getprocaddr -lal -lhtml5 -lstubs -lc-mt -ldlmalloc-mt -lclang_rt.builtins-mt -lsockets-mt -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr
wasm-ld: warning: dynamic imports are not yet stable (--unresolved-symbols=import-dynamic)
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/wasm-ld -o reused.wasm --export-if-defined=setThrew --export-if-defined=_emscripten_stack_restore --export-if-defined=emscripten_stack_get_current --export-if-defined=_emscripten_find_dylib --export-if-defined=_emscripten_stack_alloc --export-if-defined=emscripten_get_sbrk_ptr --export-if-defined=__heap_base --export-if-defined=calloc --export-if-defined=_emscripten_thread_init --export-if-defined=_emscripten_thread_free_data --export-if-defined=pthread_self --export-if-defined=__set_thread_state --export-if-defined=emscripten_stack_set_limits --export-if-defined=_emscripten_thread_exit --export-if-defined=_emscripten_tempret_get --export-if-defined=_emscripten_tempret_set --export-if-defined=strerror --export-if-defined=htons --export-if-defined=ntohs --export-if-defined=malloc --export-if-defined=htonl --export-if-defined=_emscripten_timeout --export-if-defined=realloc --export-if-defined=_emscripten_run_js_on_main_thread --export-if-defined=_emscripten_run_callback_on_thread --export-if-defined=free --export-if-defined=fileno --export-if-defined=emscripten_builtin_memalign --export-if-defined=__dl_seterr --export-if-defined=memcmp --export-if-defined=memcpy --export-if-defined=_emscripten_run_js_on_main_thread_done --export-if-defined=_emscripten_proxy_dlsync_async --export-if-defined=_emscripten_proxy_dlsync --export-if-defined=_emscripten_check_mailbox /tmp/tmpew1p1zb9libemscripten_js_symbols.so -Bdynamic --import-memory --shared-memory --strip-debug --export=__stack_pointer --export=_emscripten_stack_alloc --export=_emscripten_thread_free_data --export=_emscripten_thread_crashed --export=_emscripten_dlsync_self --export=_emscripten_dlsync_self_async --export=_emscripten_proxy_dlsync --export=_emscripten_proxy_dlsync_async --export=__dl_seterr --export=__funcs_on_exit --export=__wasm_call_ctors --export=_emscripten_tls_init --export=setThrew --export=_emscripten_stack_restore --export=emscripten_stack_get_current --export=_emscripten_find_dylib --export=emscripten_get_sbrk_ptr --export=__heap_base --export=calloc --export=_emscripten_thread_init --export=pthread_self --export=__set_thread_state --export=emscripten_stack_set_limits --export=_emscripten_thread_exit --export=_emscripten_tempret_get --export=_emscripten_tempret_set --export=strerror --export=htons --export=ntohs --export=malloc --export=htonl --export=_emscripten_timeout --export=realloc --export=_emscripten_run_js_on_main_thread --export=_emscripten_run_callback_on_thread --export=free --export=fileno --export=emscripten_builtin_memalign --export=memcmp --export=memcpy --export=_emscripten_run_js_on_main_thread_done --export=_emscripten_check_mailbox --export-if-defined=__start_em_asm --export-if-defined=__stop_em_asm --export-if-defined=__start_em_lib_deps --export-if-defined=__stop_em_lib_deps --export-if-defined=__start_em_js --export-if-defined=__stop_em_js --export-if-defined=main --export-if-defined=__main_argc_argv --export-if-defined=fflush --unresolved-symbols=import-dynamic --export-dynamic --export-table --growable-table -z stack-size=65536 --no-growable-memory --initial-memory=16777216 --no-entry --no-stack-first --table-base=1 --global-base=1024 --whole-archive /tmp/emscripten_temp_r3jihygn/reused.o -L$EM_CACHE/sysroot/lib/wasm32-emscripten/pic -L/nix/store/03iyrnrsxnbc64y6r62irmlbnbap5ya2-emscripten-6.0.9/share/emscripten/src/lib /tmp/emscripten_temp_r3jihygn/embedded_files.o $EM_CACHE/sysroot/lib/wasm32-emscripten/pic/crtbegin-mt.o -lGL-mt-getprocaddr -lal -lhtml5 -lstubs -lc-mt -ldlmalloc-mt -lclang_rt.builtins-mt -lsockets-mt --no-whole-archive -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr
wasm-ld: warning: dynamic imports are not yet stable (--unresolved-symbols=import-dynamic)
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/llvm-objcopy reused.wasm reused.wasm '--remove-section=llvm.func_attr.annotate.*' --remove-section=producers --remove-section=name '--remove-section=.debug*'
 /nix/store/lfaydgacdyngci7p60s8wwvgdm74fjkx-nodejs-24.19.0/bin/node /nix/store/03iyrnrsxnbc64y6r62irmlbnbap5ya2-emscripten-6.0.9/share/emscripten/tools/compiler.mjs -
 /nix/store/nd1279k2zlbp23gfqcl0qp5xk40xlxr8-binaryen-132/bin/wasm-opt --strip-target-features --post-emscripten -O2 --low-memory-unused --zero-filled-memory --pass-arg=directize-initial-contents-immutable reused.wasm -o reused.wasm --mvp-features --enable-threads --enable-bulk-memory --enable-bulk-memory-opt --enable-call-indirect-overlong --enable-multivalue --enable-mutable-globals --enable-nontrapping-float-to-int --enable-reference-types --enable-sign-ext
 /nix/store/lfaydgacdyngci7p60s8wwvgdm74fjkx-nodejs-24.19.0/bin/node /nix/store/03iyrnrsxnbc64y6r62irmlbnbap5ya2-emscripten-6.0.9/share/emscripten/tools/acorn-optimizer.mjs /tmp/emscripten_temp_r3jihygn/reused.js --minify-whitespace -o /tmp/emscripten_temp_r3jihygn/reused.jso1.js
```

</details>

**Where:**

- The exiting thread posts the message
  ([libpthread.js#L1212-L1218](https://github.com/emscripten-core/emscripten/blob/6.0.9/src/lib/libpthread.js#L1212-L1218),
  from [pthread_create.c#L384](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/pthread/pthread_create.c#L384)),
  before it publishes `DT_EXITED`
  ([pthread_create.c#L388](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/pthread/pthread_create.c#L388)).
- A join cleans the thread up at once
  ([pthread_join.c#L48](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/libc/musl/src/thread/pthread_join.c#L48)),
  and `cleanupThread()` drops it from `finishedThreads` and frees it
  ([libpthread.js#L659](https://github.com/emscripten-core/emscripten/blob/6.0.9/src/lib/libpthread.js#L659)).
- The message's handler marks whatever thread now has that address
  ([libpthread.js#L325-L327](https://github.com/emscripten-core/emscripten/blob/6.0.9/src/lib/libpthread.js#L325-L327)).
- The sync skips it
  ([libpthread.js#L1259](https://github.com/emscripten-core/emscripten/blob/6.0.9/src/lib/libpthread.js#L1259),
  [#L1293](https://github.com/emscripten-core/emscripten/blob/6.0.9/src/lib/libpthread.js#L1293)).

**Suggested fix:** when the message arrives, mark the thread only if it is
still known and has actually exited (`detach_state` is `DT_EXITING` or
`DT_EXITED`). A late message for a cleaned-up thread is then dropped, and one
whose address a running thread now holds doesn't mark it. If the new thread
has itself exited by then, marking it is right anyway. 15 lines added, 1
removed.

```diff
diff --git a/src/lib/libpthread.js b/src/lib/libpthread.js
--- a/src/lib/libpthread.js
+++ b/src/lib/libpthread.js
@@ -86,6 +86,7 @@ var LibraryPThread = {
                    '$addOnPreRun',
 #if MAIN_MODULE
                    '$markAsFinished',
+                   '_emscripten_thread_has_exited',
 #endif
 #if !MINIMAL_RUNTIME && PTHREAD_POOL_SIZE && !PTHREAD_POOL_DELAY_LOAD
                    '$addRunDependency',
@@ -326,7 +327,12 @@ var LibraryPThread = {
             break;
 #if MAIN_MODULE
           case {{{ CMD_MARK_AS_FINISHED }}}:
-            markAsFinished(d.thread);
+            // By the time this arrives the thread may have been joined and
+            // cleaned up, and its pthread_t reused by a new thread that is
+            // still running, which must not be marked.
+            if (PThread.pthreads[d.thread] && __emscripten_thread_has_exited(d.thread)) {
+              markAsFinished(d.thread);
+            }
             break;
 #endif
           case {{{ CMD_LOADED }}}:
diff --git a/system/lib/pthread/library_pthread.c b/system/lib/pthread/library_pthread.c
--- a/system/lib/pthread/library_pthread.c
+++ b/system/lib/pthread/library_pthread.c
@@ -153,6 +153,11 @@ int _emscripten_thread_is_valid(pthread_t thread) {
   return thread->self == thread;
 }

+int _emscripten_thread_has_exited(pthread_t thread) {
+  int state = thread->detach_state;
+  return state == DT_EXITING || state == DT_EXITED;
+}
+
 static void *dummy_tsd[1] = { 0 };
 weak_alias(dummy_tsd, __pthread_tsd_main);

diff --git a/system/lib/pthread/threading_internal.h b/system/lib/pthread/threading_internal.h
--- a/system/lib/pthread/threading_internal.h
+++ b/system/lib/pthread/threading_internal.h
@@ -93,6 +93,9 @@ void _emscripten_thread_set_strongref(pthread_t thread);
 // we can pass more of the posixtest suite than vanilla musl.
 int _emscripten_thread_is_valid(pthread_t thread);

+// Whether a thread that hasn't been cleaned up yet has run to its end.
+int _emscripten_thread_has_exited(pthread_t thread);
+
 void _emscripten_thread_exit_joinable(pthread_t thread);
 void _emscripten_thread_exit(void* result);
 void _emscripten_process_dlopen_queue(void);
```

With this applied to 6.0.9:

```
same pthread_t: yes
thread: side_value() = 42
[exit status 0]
```

A guard on the sending Worker (`worker.pthread_ptr == d.thread`) would not
be enough: the pool hands the Worker just returned straight back out, so the
new thread often runs on the same Worker at the same address.

**Test for the PR,** in the suite's format (also as
`emscripten-pthread-finished-mark-reused.tests.patch` beside this draft).
`core.test_pthread_dlsync_reused` (`@needs_dylink`, built like
`test_pthread_dlopen` with `build_dlfcn_lib`/`prep_dlfcn_main`) is the test
case above, with a retry, up to ten times, until the new thread does get the
joined thread's `pthread_t`, so that it can't pass without testing anything.
It covers `dlopen()` on the main thread; the change is in the message
handler, so it applies whichever sync runs afterwards:

```diff
diff --git a/test/core/pthread/test_pthread_dlsync_reused.c b/test/core/pthread/test_pthread_dlsync_reused.c
new file mode 100644
--- /dev/null
+++ b/test/core/pthread/test_pthread_dlsync_reused.c
@@ -0,0 +1,74 @@
+// A running thread whose pthread_t belonged to a thread joined just before
+// still takes part in dlopen()'s sync, and can call into the new module.
+// The joined thread's message that it had finished reaches the main thread
+// only once the main thread has joined it, cleaned it up and created the
+// new thread at the same address.
+
+#include <dlfcn.h>
+#include <emscripten/eventloop.h>
+#include <emscripten/threading.h>
+#include <limits.h>
+#include <math.h>
+#include <pthread.h>
+#include <stdio.h>
+#include <stdlib.h>
+
+static pthread_t waiter;
+static int go;
+static int (*value)();
+static int result;
+
+static int own_value() { return 42; }
+
+static void* quit(void* arg) { return NULL; }
+
+static void* wait_then_call(void* arg) {
+  while (__atomic_load_n(&go, __ATOMIC_SEQ_CST) == 0) {
+    emscripten_futex_wait(&go, 0, INFINITY);
+  }
+  result = value();
+  return NULL;
+}
+
+static void release_waiter() {
+  __atomic_store_n(&go, 1, __ATOMIC_SEQ_CST);
+  emscripten_futex_wake(&go, INT_MAX);
+  pthread_join(waiter, NULL);
+  go = 0;
+}
+
+// Runs once the event loop has delivered the joined thread's message.
+static void load_and_call(void* arg) {
+  void* side = dlopen("libside.so", RTLD_NOW);
+  if (side == NULL) {
+    printf("FAIL: dlopen: %s\n", dlerror());
+    exit(1);
+  }
+  value = (int (*)())dlsym(side, "side_value");
+  // A thread the sync skipped traps here.
+  release_waiter();
+  if (result != 42) {
+    printf("FAIL: the thread got %d from the side module\n", result);
+    exit(1);
+  }
+  printf("done\n");
+  exit(0);
+}
+
+int main() {
+  for (int attempt = 0; attempt < 10; attempt++) {
+    pthread_t joined;
+    pthread_create(&joined, NULL, quit, NULL);
+    // Cleans the thread up at once, its message still queued.
+    pthread_join(joined, NULL);
+    pthread_create(&waiter, NULL, wait_then_call, NULL);
+    if (pthread_equal(waiter, joined)) {
+      emscripten_set_timeout(load_and_call, 100, NULL);
+      return 0;
+    }
+    value = own_value;
+    release_waiter();
+  }
+  printf("FAIL: no new thread reused a joined thread's pthread_t\n");
+  return 1;
+}
diff --git a/test/core/pthread/test_pthread_dlsync_reused_side.c b/test/core/pthread/test_pthread_dlsync_reused_side.c
new file mode 100644
--- /dev/null
+++ b/test/core/pthread/test_pthread_dlsync_reused_side.c
@@ -0,0 +1 @@
+int side_value() { return 42; }
diff --git a/test/test_core.py b/test/test_core.py
--- a/test/test_core.py
+++ b/test/test_core.py
@@ -9414,6 +9414,16 @@ NODEFS is no longer included by default; build with -lnodefs.js
                  ['side module ctor', 'done\n', 'side module atexit'],
                  assert_all=True, cflags=args)

+  @needs_dylink
+  @requires_pthreads
+  def test_pthread_dlsync_reused(self):
+    self.cflags += ['-Wno-experimental', '-pthread']
+    self.build_dlfcn_lib(test_file('core/pthread/test_pthread_dlsync_reused_side.c'))
+    self.cflags += ['--embed-file', 'libside.so@libside.so']
+    self.prep_dlfcn_main()
+    self.set_setting('EXIT_RUNTIME')
+    self.do_runf('core/pthread/test_pthread_dlsync_reused.c', 'done\n')
+
   @needs_dylink
   @requires_pthreads
   @flaky('https://github.com/emscripten-core/emscripten/issues/18887')
```

---

## Notes for the user

- **How the fix was tested.**
  - The test case above on nixpkgs' 6.0.9: it fails without the fix, and
    passes with the fix applied alone to stock 6.0.9 (a copy of the tree
    with only this patch, its system libraries rebuilt), as well as on top
    of our stack (0001–0014).
  - `core.test_pthread_dlsync_reused`, run with Emscripten's runner (`core2`):
    FAIL on stock 6.0.9 (the trap), ok on stock 6.0.9 plus this patch
    alone, ok on our full stack.
  - Our `checks.emscripten-fixes` runs a stricter version
    (`modules/emscripten/checks/fixes/dlsync-reused.c`) on our test link
    (`MAIN_MODULE=1`, WasmFS, assertions). It also checks
    `PThread.finishedThreads` directly before the `dlopen()`, and fails if no
    `pthread_t` gets reused in ten attempts, so it can't pass vacuously. Every
    run so far reused one on the first attempt. With 0014 alone: "the
    running thread is marked finished", then the trap. With 0015: 0 failures.
  - Emscripten's own test runner, the same 198-test pthread selection as for
    0014, with 0014 and 0015 applied: the same results as unpatched 6.0.9.
  - GLib's test suite and our runtime checks, with both patches.
- **Why a separate draft.** It reproduces on stock 6.0.9 with a join on the
  main thread, so it doesn't depend on the other fix. It is small, has its
  own test, and applies to `main` alone or after the other one (`patch
--dry-run`). Upstream can take it without the bigger review the other
  needs. The other fix's PR should link here, since it adds a second way to
  hit the bug (joins on other threads whose cleanup runs early).
- **Duplicate search.** `gh` searches of the repository for
  "finishedThreads", "markAsFinished", "CMD_MARK_AS_FINISHED",
  "dlsync pthread_t reuse", "dlsync skipped thread" and "dlopen thread table
  index out of bounds" turned up:
  - #18376 ("Block in dlopen until all threads have loaded the module",
    merged): the change that added `finishedThreads`.
  - #19425 (open, 3.1.34): "table index out of bounds" when a thread created
    from a side module calls into it. It may be this bug or the older
    new-thread sync gap, and the report has no test case to tell.
  - #18631: a design discussion of shutdown handlers, not this bug.
    None reports this race.
- **Tip-of-tree.** Checked read-only through the GitHub API on 2026-10-01:
  the handler, `markAsFinished()`, `cleanupThread()` and the dlsync loops
  are unchanged on `main` (04df3de), a few lines up. 6.0.10 doesn't touch
  them. `main` wasn't rebuilt.
- ibus-web carries this fix as
  `modules/emscripten/patches/0015-pthread-finished-mark-reused.patch`. It
  matters to us because `ibusweb_load_module()` `dlopen`s engines while GLib's
  pool and GTask threads may be alive.
