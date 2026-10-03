# `dlsym(RTLD_NEXT, …)` aborts in dynamic-linking builds

**Posted: don't post again.** Filed as
[#27830](https://github.com/emscripten-core/emscripten/issues/27830)
(2026-10-01); the fix is PR
[#27838](https://github.com/emscripten-core/emscripten/pull/27838) ("[dylink]
Fail dlsym(RTLD_NEXT) cleanly rather than aborting"), approved by sbc100 on
2026-10-01 and not merged yet. ibus-web carries no patch for it.

Checked against `main` 5977ecc (2026-10-02): `__dlsym` in `dynlink.c` and
`_dlsym_js`'s assertion are unchanged since 6.0.9, so the abort stands until
#27838 lands.

**As posted** (what #27830 says, kept for reference): a new issue, reframed. The bug we found, "`HAVE_RTLD_NEXT` is detected
but `dlsym(RTLD_NEXT, …)` returns NULL in static links", is **not** filed:

- In a static link `dlsym()` is a stub that returns NULL with "dynamic linking
  not enabled" for every handle, `RTLD_DEFAULT` included
  (`emscripten_libc_stubs.c:233`). musl's own static `dlsym` behaves the same
  way.
- A maintainer has already said that `RTLD_NEXT` is unsupported and "simply
  cannot work" with static linking
  ([#23302](https://github.com/emscripten-core/emscripten/issues/23302#issuecomment-2571756300),
  sbc100: "Emscripten does not current support `RTLD_NEXT`, and furthermore we
  strongly prefer static linking where `RTLD_NEXT` simply cannot work").
- `HAVE_RTLD_NEXT` is set by GLib's `meson.build`, which only checks that
  `dlfcn.h` defines the macro. That is GLib's to fix (or ours, in the patch
  series), not Emscripten's.

The reproduction did turn up a narrower Emscripten bug. With `-sMAIN_MODULE`,
`dlsym(RTLD_NEXT, …)` doesn't fail cleanly: it aborts on an assertion, or
without assertions it throws a `TypeError`. The issue below reports only that.

## Issue title

dlsym(RTLD_NEXT, ...) aborts with "Tried to dlsym() from an unopened handle: -1" under MAIN_MODULE

## Issue body

---

With dynamic linking enabled, `dlsym(RTLD_NEXT, name)` crashes the program
instead of returning NULL. With assertions it aborts with `Tried to dlsym() from
an unopened handle: -1`. At `-O2` it throws
`TypeError: Cannot read properties of undefined (reading 'exports')`. Per #23302
`RTLD_NEXT` isn't supported, which is fine. But `<dlfcn.h>` defines it, so code
that probes for it at run time (an interposing `malloc` wrapper, say) should get
NULL and a `dlerror()` message, not an abort. In a static link it already gets
NULL with "dynamic linking not enabled".

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

**Test case** (`rtld_next.c`):

```c
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>

int main(void) {
#ifdef RTLD_NEXT
  puts("RTLD_NEXT is defined");
#endif
  void *next = dlsym(RTLD_NEXT, "puts");
  const char *err = next ? NULL : dlerror();
  printf("dlsym(RTLD_NEXT, \"puts\") = %p (%s)\n", next, err ? err : "no error");
  void *dflt = dlsym(RTLD_DEFAULT, "puts");
  err = dflt ? NULL : dlerror();
  printf("dlsym(RTLD_DEFAULT, \"puts\") = %p (%s)\n", dflt, err ? err : "no error");
  return 0;
}
```

**Failing command line in full:**

```
$ emcc -O0 -sMAIN_MODULE=2 rtld_next.c -o rtld_next.js && node rtld_next.js
wasm-ld: warning: dynamic imports are not yet stable (--unresolved-symbols=import-dynamic)
RTLD_NEXT is defined
Aborted(Assertion failed: Tried to dlsym() from an unopened handle: -1)
rtld_next.js:599
  var e = new WebAssembly.RuntimeError(what);
          ^

RuntimeError: Aborted(Assertion failed: Tried to dlsym() from an unopened handle: -1)
    at abort (rtld_next.js:599:11)
    at assert (rtld_next.js:278:5)
    at __dlsym_js (rtld_next.js:4831:7)
    at wasm://wasm/0001d56a:wasm-function[27]:0xac5
    at wasm://wasm/0001d56a:wasm-function[19]:0x7ad
    at wasm://wasm/0001d56a:wasm-function[13]:0x4c2
    at wasm://wasm/0001d56a:wasm-function[14]:0x604
    at callMain (rtld_next.js:5688:15)
    at run (rtld_next.js:5738:22)
    at rtld_next.js:5786:25

Node.js v24.20.0
[exit status 1]
```

`-sMAIN_MODULE=1` and `-sWASMFS` abort the same way. Without assertions:

```
$ emcc -O2 -sMAIN_MODULE=2 rtld_next.c -o rtld_next.js && node rtld_next.js > run.log 2>&1; sed -n "/^RTLD/p; /^TypeError/p" run.log
wasm-ld: warning: dynamic imports are not yet stable (--unresolved-symbols=import-dynamic)
RTLD_NEXT is defined
TypeError: Cannot read properties of undefined (reading 'exports')
```

For comparison, a static link and native glibc:

```
$ emcc -O0 rtld_next.c -o rtld_next.js && node rtld_next.js
RTLD_NEXT is defined
dlsym(RTLD_NEXT, "puts") = 0 (dynamic linking not enabled)
dlsym(RTLD_DEFAULT, "puts") = 0 (dynamic linking not enabled)
$ cc rtld_next.c -o rtld_next && ./rtld_next
RTLD_NEXT is defined
dlsym(RTLD_NEXT, "puts") = 0x7a45b900ae90 (no error)
dlsym(RTLD_DEFAULT, "puts") = 0x7a45b900ae90 (no error)
```

<details>
<summary>Full compile and link output with <code>-v</code> appended (cache and scratch paths shortened)</summary>

```
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/clang -target wasm32-unknown-emscripten -fignore-exceptions -fPIC -fvisibility=default -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr --sysroot=$EM_CACHE/sysroot -resource-dir=/nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter$EM_CACHE/sysroot/include -iwithsysroot/include/c++/v1 -Xclang -iwithsysroot/include/fakesdl -Xclang -iwithsysroot/include/compat -v -O0 -c rtld_next.c -o /tmp/emscripten_temp_ldoy77ur/rtld_next.o
clang version 22.1.8
Target: wasm32-unknown-emscripten
Thread model: posix
InstalledDir: /nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin
 (in-process)
 "/nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin/clang-22" -cc1 -triple wasm32-unknown-emscripten -O0 -emit-obj -disable-free -clear-ast-before-backend -disable-llvm-verifier -discard-value-names -main-file-name rtld_next.c -mrelocation-model pic -pic-level 2 -mframe-pointer=none -ffp-contract=on -fno-rounding-math -mconstructor-aliases -target-feature +mutable-globals -target-cpu generic -debugger-tuning=gdb -fdebug-compilation-dir=. -v -fcoverage-compilation-dir=. -resource-dir /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter $EM_CACHE/sysroot/include -iwithsysroot /include/c++/v1 -isysroot $EM_CACHE/sysroot -internal-isystem /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/include -internal-isystem $EM_CACHE/sysroot/include/wasm32-emscripten -internal-isystem $EM_CACHE/sysroot/include -ferror-limit 19 -fvisibility=default -fgnuc-version=4.2.1 -fskip-odr-check-in-gmf -fignore-exceptions -iwithsysroot/include/fakesdl -iwithsysroot/include/compat -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr -o /tmp/emscripten_temp_ldoy77ur/rtld_next.o -x c rtld_next.c
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
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/wasm-ld -o rtld_next.wasm /tmp/tmp1bt37q29libemscripten_js_symbols.so -Bdynamic --strip-debug --export=__stack_pointer --export=emscripten_stack_get_end --export=emscripten_stack_get_free --export=emscripten_stack_get_base --export=emscripten_stack_get_current --export=emscripten_stack_init --export=_emscripten_stack_alloc --export=__wasm_call_ctors --export=setThrew --export=_emscripten_stack_restore --export=_emscripten_find_dylib --export=strerror --export=emscripten_get_sbrk_ptr --export=__heap_base --export=calloc --export-if-defined=__start_em_asm --export-if-defined=__stop_em_asm --export-if-defined=__start_em_lib_deps --export-if-defined=__stop_em_lib_deps --export-if-defined=__start_em_js --export-if-defined=__stop_em_js --export-if-defined=main --export-if-defined=__main_argc_argv --export-if-defined=fflush --unresolved-symbols=import-dynamic --export-table --growable-table -z stack-size=65536 --no-growable-memory --initial-heap=16777216 --no-entry --stack-first --table-base=1 /tmp/emscripten_temp_ldoy77ur/rtld_next.o -L$EM_CACHE/sysroot/lib/wasm32-emscripten/pic -L/nix/store/03iyrnrsxnbc64y6r62irmlbnbap5ya2-emscripten-6.0.9/share/emscripten/src/lib -lGL-getprocaddr -lal -lhtml5 -lstubs-debug -lnoexit -lc-debug -ldlmalloc-debug -lclang_rt.builtins -lsockets -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr
wasm-ld: warning: dynamic imports are not yet stable (--unresolved-symbols=import-dynamic)
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/llvm-objcopy rtld_next.wasm rtld_next.wasm '--remove-section=llvm.func_attr.annotate.*' --remove-section=producers --remove-section=name '--remove-section=.debug*'
```

</details>

**Where:**

- `__dlsym` deliberately lets `RTLD_NEXT` past the handle check
  ([dynlink.c#L630](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/libc/dynlink.c#L630)).
- It then passes `RTLD_NEXT`, `(void *)-1`, to `_dlsym_js`, which looks it up in
  `LDSO.loadedLibsByHandle`, finds nothing, and asserts
  ([libdylink.js#L1362-L1366](https://github.com/emscripten-core/emscripten/blob/6.0.9/src/lib/libdylink.js#L1362-L1366)).
- musl's `dlsym` always passes a null return address
  ([dlsym.c#L6](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/libc/musl/src/ldso/dlsym.c#L6)),
  so `__dlsym` couldn't find "the next object after the caller" even if it
  tried.

**Suggested fix:** fail `RTLD_NEXT` explicitly.

```diff
--- a/system/lib/libc/dynlink.c
+++ b/system/lib/libc/dynlink.c
@@ -627,7 +627,11 @@

 void* __dlsym(void* restrict p, const char* restrict s, void* restrict ra) {
   dbg("__dlsym dso:%p sym:%s", p, s);
-  if (p != RTLD_DEFAULT && p != RTLD_NEXT && __dl_invalid_handle(p)) {
+  if (p == RTLD_NEXT) {
+    __dl_seterr("RTLD_NEXT is not supported");
+    return 0;
+  }
+  if (p != RTLD_DEFAULT && __dl_invalid_handle(p)) {
     return 0;
   }
   // The first "dso" is always the default one which is equivalent to
```

With this applied to 6.0.9, the program prints this under `-sMAIN_MODULE=2`:

```
RTLD_NEXT is defined
dlsym(RTLD_NEXT, "puts") = 0 (RTLD_NEXT is not supported)
dlsym(RTLD_DEFAULT, "puts") = 0 (Tried to lookup unknown symbol "puts" in dynamic lib: __main__)
```

and this under `-sMAIN_MODULE=1`:

```
RTLD_NEXT is defined
dlsym(RTLD_NEXT, "puts") = 0 (RTLD_NEXT is not supported)
dlsym(RTLD_DEFAULT, "puts") = 0x3f (no error)
```

(The `RTLD_DEFAULT` lookup fails under `MAIN_MODULE=2` only because `puts`
isn't exported there.)

Treating `RTLD_NEXT` as `RTLD_DEFAULT` would be the wrong fallback. The usual
caller is an interposer, such as a `malloc` that looks up "the real `malloc`".
`RTLD_DEFAULT` would hand that caller its own function back, and it would
recurse forever.

---

## Notes for the user

- **FAQ.** The FAQ says nothing about `dlsym` or `RTLD_NEXT`. The static
  behaviour is reframed out because a maintainer called it a known limitation
  in #23302, not because of the FAQ. As the FAQ suggests, the case was run at
  `-O0` (assertion message) and `-O2` (`TypeError`). No test in `test/`
  mentions `RTLD_NEXT`.
- **bug_reports.rst.** The source, `emcc -v`, the symptoms and a tested fix are
  included. Bitcode is left out: the fault is in `__dlsym`/`_dlsym_js`, and the
  test's `.o` adds nothing. The diff is small enough to send as a PR instead,
  which the guide prefers.
- **Duplicate search.** "RTLD_NEXT", "dlsym RTLD_NEXT", "unopened handle", the
  exact assertion text, "dlsym RTLD_DEFAULT static", "dynamic linking not
  enabled dlsym", "dlsym abort", "dlsym assertion", "RTLD_NEXT abort" and
  "dlsym" turned up only #23302 (a question about interposing libc calls, where
  the maintainer explains `RTLD_NEXT` is unsupported). Nobody has reported the
  abort.
- **Is it worth filing?** It's a crash on an unsupported call, in a
  configuration (`MAIN_MODULE`) our runtime uses. The GLib cases we hit
  (socket-listener's mocks, messages-low-memory's `malloc` wrapper) are static
  links. They get NULL and then call through it, which is the GLib-side bug.
  Skip this one if a crash in a corner of `MAIN_MODULE` isn't worth a
  maintainer's time.
- **GLib side.** GLib's `meson.build` sets `HAVE_RTLD_NEXT` because musl's
  `dlfcn.h` defines `RTLD_NEXT`. Turning it off for Emscripten in our patch
  series is a one-line alternative to the per-test guards.
- **Tip-of-tree.** Checked read-only through the GitHub API on 2026-09-30:
  `dynlink.c`, `emscripten_libc_stubs.c` and musl's `dlsym.c` are unchanged
  between 6.0.9 and `main` (2151200, 139 commits later). `libdylink.js` changed
  elsewhere (the preload plugin, a `dylink.0` architecture check, `dlopen`
  callbacks), but `_dlsym_js` and its assertion didn't. The latest release,
  6.0.10 (tagged 2026-09-18), matches. The conclusion comes from the diff;
  `main` wasn't rebuilt. Our build is nixpkgs' 6.0.9 with LLVM 22.1.8.
