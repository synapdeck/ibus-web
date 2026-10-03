# WasmFS: `fstat()` on a pipe reports `S_IFREG`, not `S_IFIFO`

**Done upstream: don't post.** Filed as
[#27827](https://github.com/emscripten-core/emscripten/issues/27827) and
fixed by [#27842](https://github.com/emscripten-core/emscripten/pull/27842)
("[WasmFS] Report pipes as S_IFIFO", merged 2026-10-02 as a0014542110d, with
`test/unistd/pipe.c` asserting `S_ISFIFO()` on both ends). That commit is
the 6.0.11 release (marked released on `main` 2026-10-02; emsdk's 6.0.11
builds it), so drop patch 0004 once nixpkgs packages 6.0.11 or later.

Checked against `main` 5977ecc (2026-10-02): 0004 reverse-applies cleanly
(`git apply -R --check`); `main` makes the same one-line change.

**Draft: new issue.** No existing issue covers it. #16158 ("mkfifo() and
mknod() create regular file with NODERAWFS=1", open) is a different code path:
NODERAWFS's `mknod`, not WasmFS's `pipe()`.

## Issue title

WasmFS: fstat() on a pipe() end reports S_IFREG instead of S_IFIFO

## Issue body

---

Under WasmFS, both ends of a `pipe()` report a regular file's type from
`fstat()`. Code that tells pipes from files by `S_ISFIFO` (to decide whether an
fd can be polled, can seek, or gets a size) takes a WasmFS pipe for a regular
file. The JS file system and Linux report `S_IFIFO`.

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

**Test case** (`pipe_mode.c`):

```c
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>
int main(void) {
  int p[2];
  pipe(p);
  struct stat st;
  fstat(p[0], &st);
  printf("S_ISFIFO=%d S_ISREG=%d\n", S_ISFIFO(st.st_mode), S_ISREG(st.st_mode));
}
```

**Failing command line in full** (the same at `-O2`):

```
$ emcc -O0 -sWASMFS pipe_mode.c -o pipe_mode.js && node pipe_mode.js
S_ISFIFO=0 S_ISREG=1
```

The JS file system and native Linux:

```
$ emcc -O0 pipe_mode.c -o pipe_mode.js && node pipe_mode.js
S_ISFIFO=1 S_ISREG=0
$ cc pipe_mode.c -o pipe_mode && ./pipe_mode
S_ISFIFO=1 S_ISREG=0
```

<details>
<summary>Full compile and link output with <code>-v</code> appended (cache and scratch paths shortened)</summary>

```
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/clang -target wasm32-unknown-emscripten -fignore-exceptions -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr --sysroot=$EM_CACHE/sysroot -resource-dir=/nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter$EM_CACHE/sysroot/include -iwithsysroot/include/c++/v1 -Xclang -iwithsysroot/include/fakesdl -Xclang -iwithsysroot/include/compat -v -O0 -c pipe_mode.c -o /tmp/emscripten_temp_i706ijfi/pipe_mode.o
clang version 22.1.8
Target: wasm32-unknown-emscripten
Thread model: posix
InstalledDir: /nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin
 (in-process)
 "/nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin/clang-22" -cc1 -triple wasm32-unknown-emscripten -O0 -emit-obj -disable-free -clear-ast-before-backend -disable-llvm-verifier -discard-value-names -main-file-name pipe_mode.c -mrelocation-model static -mframe-pointer=none -ffp-contract=on -fno-rounding-math -mconstructor-aliases -target-cpu generic -fvisibility=hidden -debugger-tuning=gdb -fdebug-compilation-dir=. -v -fcoverage-compilation-dir=. -resource-dir /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter $EM_CACHE/sysroot/include -iwithsysroot /include/c++/v1 -isysroot $EM_CACHE/sysroot -internal-isystem /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/include -internal-isystem $EM_CACHE/sysroot/include/wasm32-emscripten -internal-isystem $EM_CACHE/sysroot/include -ferror-limit 19 -fgnuc-version=4.2.1 -fskip-odr-check-in-gmf -fignore-exceptions -iwithsysroot/include/fakesdl -iwithsysroot/include/compat -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr -o /tmp/emscripten_temp_i706ijfi/pipe_mode.o -x c pipe_mode.c
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
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/wasm-ld -o pipe_mode.wasm /tmp/tmpjs6t0qxolibemscripten_js_symbols.so -Bstatic --strip-debug --export=emscripten_stack_get_end --export=emscripten_stack_get_free --export=emscripten_stack_get_base --export=emscripten_stack_get_current --export=emscripten_stack_init --export=wasmfs_flush --export=_emscripten_stack_alloc --export=__wasm_call_ctors --export=_emscripten_stack_restore --export-if-defined=__start_em_asm --export-if-defined=__stop_em_asm --export-if-defined=__start_em_lib_deps --export-if-defined=__stop_em_lib_deps --export-if-defined=__start_em_js --export-if-defined=__stop_em_js --export-if-defined=main --export-if-defined=__main_argc_argv --export-if-defined=fflush --export-table -z stack-size=65536 --no-growable-memory --initial-heap=16777216 --no-entry --stack-first --table-base=1 /tmp/emscripten_temp_i706ijfi/pipe_mode.o -L$EM_CACHE/sysroot/lib/wasm32-emscripten -L/nix/store/03iyrnrsxnbc64y6r62irmlbnbap5ya2-emscripten-6.0.9/share/emscripten/src/lib -lGL-getprocaddr -lal -lhtml5 -lstubs-debug -lnoexit -lc-debug -ldlmalloc-debug -lclang_rt.builtins -lc++-debug-noexcept -lc++abi-debug-noexcept -lsockets -lwasmfs_no_fs -lwasmfs-debug -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/llvm-objcopy pipe_mode.wasm pipe_mode.wasm '--remove-section=llvm.func_attr.annotate.*' --remove-section=producers --remove-section=name '--remove-section=.debug*'
```

</details>

**Where:**

- `PipeFile` uses `DataFile`'s two-argument constructor
  ([pipe_backend.h#L57-L58](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/pipe_backend.h#L57-L58)).
- That constructor ORs in `S_IFREG`
  ([file.h#L157-L158](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/file.h#L157-L158)).
- The three-argument constructor that the device files use to get `S_IFCHR`
  ([file.h#L159-L160](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/file.h#L159-L160))
  would give pipes `S_IFIFO`.

**Suggested fix:**

```diff
--- a/system/lib/wasmfs/pipe_backend.h
+++ b/system/lib/wasmfs/pipe_backend.h
@@ -55,7 +55,7 @@
   // PipeFiles do not have or need a backend. Pass NullBackend to the parent for
   // that.
   PipeFile(mode_t mode, std::shared_ptr<PipeData> data)
-    : DataFile(mode, NullBackend), data(data) {
+    : DataFile(mode, NullBackend, S_IFIFO), data(data) {
     // Reads are always from the front; writes always to the end.
     seekable = false;
   }
```

With this applied to 6.0.9, the test case prints:

```
S_ISFIFO=1 S_ISREG=0
```

Nothing in `system/lib/wasmfs` tests a data file's type bits (`S_ISREG`
appears only in the Node backend's lookup of host files), so the change
affects only what `fstat()` reports.

---

## Notes for the user

- **FAQ.** Nothing in the FAQ covers pipe types. Run at `-O0` and `-O2`, with
  the same result.
- **bug_reports.rst.** The source, `emcc -v`, the symptoms and a tested
  one-line fix are included. Bitcode is left out because the fault is in
  `libwasmfs`. A natural one-line PR, with an `S_ISFIFO` assertion added to a
  WasmFS pipe test.
- **Testing.** The fixed run used a 6.0.9 tree with all of this set's
  candidate fixes applied at once. `test/unistd/pipe.c` (WasmFS variant),
  `test/core/test_pipe_select.c` and the `test/wasmfs/*.c` programs gave the
  same results with and without it.
- **Duplicate search.** "S_IFIFO", "pipe fstat", "pipe S_ISFIFO" and "pipe",
  plus a scan of all open "wasmfs" issues, turned up only #16158 (NODERAWFS
  `mkfifo`/`mknod`) and #16269 ("WasmFS: Allow backends to implement readv to
  support pipes"). Neither is this bug.
- **Why it matters to us.** GLib's `_g_fd_is_pollable()` decides by
  `S_ISFIFO`. Our GLib patches had to add "or an unseekable file that isn't a
  character device" to recognise WasmFS pipes.
- **Tip-of-tree.** Checked read-only through the GitHub API on 2026-09-30:
  `pipe_backend.h` and `file.h` are unchanged between 6.0.9 and `main`
  (2151200, 139 commits later). The latest release, 6.0.10 (tagged 2026-09-18),
  matches. The conclusion comes from the diff; `main` wasn't rebuilt. Our build
  is nixpkgs' 6.0.9 with LLVM 22.1.8.
- ibus-web carries this fix as `modules/emscripten/patches/0004-wasmfs-pipe-fifo-mode.patch`.
