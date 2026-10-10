# Pipes have no capacity: a non-blocking writer never sees `EAGAIN`

**Posted: don't post again.** Filed as [#27831](https://github.com/emscripten-core/emscripten/issues/27831) (2026-10-01,
no replies yet). ibus-web doesn't carry a fix, by decision.

Checked against `main` 5977ecc (2026-10-02): `libpipefs.js` is unchanged since 6.0.9 and `pipe_backend.h` still queues
without limit (its only change is #27842's `S_IFIFO`), so the report stands. #27815 lets WasmFS's `pipe2()` take
`O_NONBLOCK`, which makes a non-blocking pipe easier to get but adds no capacity.

**As posted** (what #27831 says, kept for reference). When drafted, no existing issue covered it. Unbounded pipes look
partly deliberate. `pipe_backend.h` has "TODO: Consider switching to a ring buffer … if we don't need unbounded pipes",
and Emscripten pipes can't block, which is the usual reason to have a capacity. So the report asks only for a capacity
that **non-blocking** writers see, which no current program can rely on being absent. Drop it if that framing still
reads as a feature request. It affects both file systems, so it isn't WasmFS-only.

## Issue title

Pipes are unbounded: a non-blocking writer never gets EAGAIN (and WasmFS runs out of memory)

## Issue body

---

On Linux a pipe holds 64 KiB; past that, a non-blocking `write()` fails with `EAGAIN`. Emscripten's pipes have no limit
under either file system. Code that fills a pipe until `EAGAIN` (to test back-pressure, or to detect a full pipe) never
stops:

- Under the JS file system the bytes pile up in JS memory.
- Under WasmFS they go into a `std::queue` on the wasm heap. Without `ALLOW_MEMORY_GROWTH` that is an OOM abort; with
  it, the heap grows until something gives.

**Version of emscripten/emsdk:**

```
emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 6.0.9-git
clang version 22.1.8
Target: wasm32-unknown-emscripten
Thread model: posix
InstalledDir: /nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin
```

This is the 6.0.9 release tag as packaged by nixpkgs. nixpkgs builds it against its own LLVM 22.1.8, so there is no
commit hash. Node.js v24.20.0, x86_64 Linux.

**Test case** (`pipe_capacity.c`, which gives up at 16 MiB):

```c
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(void) {
  int p[2];
  pipe(p);
  int r = fcntl(p[1], F_SETFL, O_NONBLOCK);
  printf("fcntl(F_SETFL, O_NONBLOCK) = %d\n", r);

  /* Write without reading until the pipe is full, giving up at 16 MiB. */
  static char chunk[4096];
  size_t total = 0;
  ssize_t n;
  while (total < (16u << 20) && (n = write(p[1], chunk, sizeof chunk)) > 0) {
    total += n;
  }
  printf("wrote %zu bytes; last write: %s\n", total,
         total < (16u << 20) ? strerror(errno) : "still succeeding");
  return 0;
}
```

**Failing command line in full:**

```
$ emcc -O0 pipe_capacity.c -o pipe_capacity.js && node pipe_capacity.js
fcntl(F_SETFL, O_NONBLOCK) = 0
wrote 16777216 bytes; last write: still succeeding
$ emcc -O0 -sWASMFS pipe_capacity.c -o pipe_capacity.js && node pipe_capacity.js
fcntl(F_SETFL, O_NONBLOCK) = 0
Aborted(Cannot enlarge memory arrays to size 16912384 bytes (OOM). Either (1) compile with -sINITIAL_MEMORY=X with X higher than the current value 16908288, (2) compile with -sALLOW_MEMORY_GROWTH which allows increasing the size at runtime, or (3) if you want malloc to return NULL (0) instead of this abort, compile with -sABORTING_MALLOC=0)
pipe_capacity.js:584
  var e = new WebAssembly.RuntimeError(what);
          ^

RuntimeError: Aborted(Cannot enlarge memory arrays to size 16912384 bytes (OOM). Either (1) compile with -sINITIAL_MEMORY=X with X higher than the current value 16908288, (2) compile with -sALLOW_MEMORY_GROWTH which allows increasing the size at runtime, or (3) if you want malloc to return NULL (0) instead of this abort, compile with -sABORTING_MALLOC=0)
    at abort (pipe_capacity.js:584:11)
    at abortOnCannotGrowMemory (pipe_capacity.js:1093:7)
    at _emscripten_resize_heap (pipe_capacity.js:1100:7)
    at wasm://wasm/0005543a:wasm-function[96]:0x3b6c
    at wasm://wasm/0005543a:wasm-function[97]:0x485c
    at wasm://wasm/0005543a:wasm-function[103]:0x5c73
    at wasm://wasm/0005543a:wasm-function[102]:0x5c48
    at wasm://wasm/0005543a:wasm-function[307]:0xeff8
    at wasm://wasm/0005543a:wasm-function[306]:0xef0c
    at wasm://wasm/0005543a:wasm-function[278]:0xda3c

Node.js v24.20.0
[exit status 1]
$ emcc -O2 -sWASMFS -sALLOW_MEMORY_GROWTH pipe_capacity.c -o pipe_capacity.js && node pipe_capacity.js
fcntl(F_SETFL, O_NONBLOCK) = 0
wrote 16777216 bytes; last write: still succeeding
```

Native Linux:

```
$ cc pipe_capacity.c -o pipe_capacity && ./pipe_capacity
fcntl(F_SETFL, O_NONBLOCK) = 0
wrote 65536 bytes; last write: Resource temporarily unavailable
```

<details>
<summary>Full compile and link output with <code>-v</code> appended (WasmFS build; cache and scratch paths shortened)</summary>

```
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/clang -target wasm32-unknown-emscripten -fignore-exceptions -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr --sysroot=$EM_CACHE/sysroot -resource-dir=/nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter$EM_CACHE/sysroot/include -iwithsysroot/include/c++/v1 -Xclang -iwithsysroot/include/fakesdl -Xclang -iwithsysroot/include/compat -v -O0 -c pipe_capacity.c -o /tmp/emscripten_temp_73u6np6h/pipe_capacity.o
clang version 22.1.8
Target: wasm32-unknown-emscripten
Thread model: posix
InstalledDir: /nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin
 (in-process)
 "/nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin/clang-22" -cc1 -triple wasm32-unknown-emscripten -O0 -emit-obj -disable-free -clear-ast-before-backend -disable-llvm-verifier -discard-value-names -main-file-name pipe_capacity.c -mrelocation-model static -mframe-pointer=none -ffp-contract=on -fno-rounding-math -mconstructor-aliases -target-cpu generic -fvisibility=hidden -debugger-tuning=gdb -fdebug-compilation-dir=. -v -fcoverage-compilation-dir=. -resource-dir /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter $EM_CACHE/sysroot/include -iwithsysroot /include/c++/v1 -isysroot $EM_CACHE/sysroot -internal-isystem /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/include -internal-isystem $EM_CACHE/sysroot/include/wasm32-emscripten -internal-isystem $EM_CACHE/sysroot/include -ferror-limit 19 -fgnuc-version=4.2.1 -fskip-odr-check-in-gmf -fignore-exceptions -iwithsysroot/include/fakesdl -iwithsysroot/include/compat -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr -o /tmp/emscripten_temp_73u6np6h/pipe_capacity.o -x c pipe_capacity.c
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
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/wasm-ld -o pipe_capacity.wasm /tmp/tmp505dkwo9libemscripten_js_symbols.so -Bstatic --strip-debug --export=emscripten_stack_get_end --export=emscripten_stack_get_free --export=emscripten_stack_get_base --export=emscripten_stack_get_current --export=emscripten_stack_init --export=wasmfs_flush --export=_emscripten_stack_alloc --export=__wasm_call_ctors --export=_emscripten_stack_restore --export-if-defined=__start_em_asm --export-if-defined=__stop_em_asm --export-if-defined=__start_em_lib_deps --export-if-defined=__stop_em_lib_deps --export-if-defined=__start_em_js --export-if-defined=__stop_em_js --export-if-defined=main --export-if-defined=__main_argc_argv --export-if-defined=fflush --export-table -z stack-size=65536 --no-growable-memory --initial-heap=16777216 --no-entry --stack-first --table-base=1 /tmp/emscripten_temp_73u6np6h/pipe_capacity.o -L$EM_CACHE/sysroot/lib/wasm32-emscripten -L/nix/store/03iyrnrsxnbc64y6r62irmlbnbap5ya2-emscripten-6.0.9/share/emscripten/src/lib -lGL-getprocaddr -lal -lhtml5 -lstubs-debug -lnoexit -lc-debug -ldlmalloc-debug -lclang_rt.builtins -lc++-debug-noexcept -lc++abi-debug-noexcept -lsockets -lwasmfs_no_fs -lwasmfs-debug -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/llvm-objcopy pipe_capacity.wasm pipe_capacity.wasm '--remove-section=llvm.func_attr.annotate.*' --remove-section=producers --remove-section=name '--remove-section=.debug*'
```

</details>

**Where:**

- JS FS: `PIPEFS.stream_ops.write` accepts every write, adding buckets without limit
  ([libpipefs.js#L205-L277](https://github.com/emscripten-core/emscripten/blob/6.0.9/src/lib/libpipefs.js#L205-L277)).
- WasmFS: `PipeFile::write` pushes every byte onto an unbounded `std::queue<uint8_t>`
  ([pipe_backend.h#L18](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/pipe_backend.h#L18),
  [#L29-L34](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/pipe_backend.h#L29-L34)).

**Suggested fix (JS FS):** give non-blocking writers Linux's 64 KiB capacity, with `PIPE_BUF`'s all-or-nothing rule for
small writes. Blocking writers keep today's unbounded behaviour, since they can't wait for a reader.

```diff
--- a/src/lib/libpipefs.js
+++ b/src/lib/libpipefs.js
@@ -9,6 +9,9 @@
   $PIPEFS__deps: ['$FS'],
   $PIPEFS: {
     BUCKET_BUFFER_SIZE: 1024 * 8, // 8KiB Buffer
+    // Linux's default pipe capacity. Only non-blocking writers see it, since a
+    // blocking write can't wait for a reader.
+    CAPACITY: 65536,
     mount(mount) {
       // Do not pollute the real root directory or its child nodes with pipes
       // Looks like it is OK to create another pseudo-root node not linked to the FS.root hierarchy this way
@@ -218,6 +221,21 @@
         if (dataLen <= 0) {
           return 0;
         }
+        if (stream.flags & {{{ cDefs.O_NONBLOCK }}}) {
+          var queued = 0;
+          for (var bucket of pipe.buckets) {
+            queued += bucket.offset - bucket.roffset;
+          }
+          var room = PIPEFS.CAPACITY - queued;
+          // Writes of up to PIPE_BUF bytes are atomic: all or nothing.
+          if (room <= 0 || (dataLen <= 4096 /* PIPE_BUF */ && dataLen > room)) {
+            throw new FS.ErrnoError({{{ cDefs.EAGAIN }}});
+          }
+          if (dataLen > room) {
+            data = data.subarray(0, room);
+            dataLen = room;
+          }
+        }

         var currBucket = null;
```

With this applied to 6.0.9, the JS FS build prints:

```
fcntl(F_SETFL, O_NONBLOCK) = 0
wrote 65536 bytes; last write: Resource temporarily unavailable
```

**WasmFS** would need the same check. `DataFile::write` doesn't see the open file's flags, so the check belongs in the
syscall layer, which has the `OpenFileState`. Alternatively, `PipeFile` could take the flags at write time. We haven't
written that part.

---

## Evidence

- **Judgement call.** A maintainer may answer that unbounded pipes are intended, since writers can't block. The draft
  pre-empts that by limiting the request to `O_NONBLOCK` writers. If the answer is still no, the useful outcome is a
  documented limitation. The WasmFS OOM abort is the strongest argument.
- **FAQ.** Nothing in the FAQ covers pipe capacity. Run at `-O0` (both FS) and at `-O2` with memory growth (WasmFS).
- **bug_reports.rst.** The source, `emcc -v`, the symptoms and a tested JS FS fix are included. The WasmFS fix is a
  sketch. Bitcode is left out because the fault is in the runtime libraries.
- **Testing.** The fixed JS FS run used a 6.0.9 tree with all of this set's candidate fixes applied at once.
  `test/core/test_pipe_pollhup.c`, `test/unistd/pipe.c` and `test/core/test_pipe_select.c` gave the same results with
  and without it. `unistd/pipe.c` never has more than about 33 KiB queued and makes only the read end non-blocking, so
  the cap doesn't reach it.
- **Duplicate search.** "pipe capacity", "pipe full", "pipe buffer size", "PIPE_BUF", "F_GETPIPE_SZ" and "pipe", plus a
  scan of all open "wasmfs" issues, turned up only blocking-pipe issues (#13214, #22029, #27683) and an unrelated 2013
  issue. None is about capacity.
- **Why it matters to us.** GLib's `/mainloop/unix-fd` fills a pipe with `fill_a_pipe()` until `EAGAIN`. Under WasmFS it
  ran the heap out at 2 GiB, so our GLib test patch skips it.
- **Tip-of-tree.** Checked read-only through the GitHub API on 2026-09-30: `libpipefs.js` and `pipe_backend.h` are
  unchanged between 6.0.9 and `main` (2151200, 139 commits later). The latest release, 6.0.10 (tagged 2026-09-18),
  matches. The conclusion comes from the diff; `main` wasn't rebuilt. Our build is nixpkgs' 6.0.9 with LLVM 22.1.8.
