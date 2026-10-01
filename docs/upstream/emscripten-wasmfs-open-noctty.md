# WasmFS: `open()` with `O_NOCTTY` aborts on an assertion in `doOpen`

**Draft: new issue.** No existing issue covers the WasmFS side.
[#11927](https://github.com/emscripten-core/emscripten/issues/11927) ("NODEFS.flagsForNode
does not support O_NOCTTY", closed 2020) was the same flag in the legacy NODEFS,
fixed by #12492. [#15524](https://github.com/emscripten-core/emscripten/issues/15524)
("Open USB device", closed 2021) passes `O_NOCTTY` under NODERAWFS, but its
problem was `tcgetattr` on a non-tty stream. Neither touches WasmFS.

## Issue title

WasmFS: open() with O_NOCTTY (or O_SYNC/O_DSYNC) aborts on the flag assertion in doOpen

## Issue body

---

With assertions enabled (`-O0`, or `-sASSERTIONS`), WasmFS aborts any `open()`
whose flags include something outside a fixed list. `O_NOCTTY` is the common
case: musl's `openpty()` passes it, and so does plenty of portable code
(gzip, serial-port code). It means nothing in WasmFS, which has no controlling
terminals. Release builds skip the assertion and ignore the flag, so the same
program behaves differently depending on `ASSERTIONS`. The JS file system
accepts the flag.

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

**Test case** (`open_noctty.c`):

```c
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(void) {
  int fd = open("/tmp/file", O_CREAT | O_WRONLY, 0644);
  close(fd);
  printf("opening with O_NOCTTY\n");
  fflush(stdout);
  errno = 0;
  fd = open("/tmp/file", O_RDONLY | O_NOCTTY);
  printf("open = %d (%s)\n", fd, fd < 0 ? strerror(errno) : "no error");
  return 0;
}
```

**Failing command line in full:**

```
$ emcc -O0 -sWASMFS open_noctty.c -o open_noctty.js && node open_noctty.js
opening with O_NOCTTY
Aborted(Assertion failed: (flags & ~(O_CREAT | O_EXCL | O_DIRECTORY | O_TRUNC | O_APPEND | O_RDWR | O_WRONLY | O_RDONLY | O_LARGEFILE | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)) == 0, at: /emsdk/emscripten/system/lib/wasmfs/syscalls.cpp,441,doOpen)
open_noctty.js:584
  var e = new WebAssembly.RuntimeError(what);
          ^

RuntimeError: Aborted(Assertion failed: (flags & ~(O_CREAT | O_EXCL | O_DIRECTORY | O_TRUNC | O_APPEND | O_RDWR | O_WRONLY | O_RDONLY | O_LARGEFILE | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)) == 0, at: /emsdk/emscripten/system/lib/wasmfs/syscalls.cpp,441,doOpen)
    at abort (open_noctty.js:584:11)
    at ___assert_fail (open_noctty.js:904:7)
    at wasm://wasm/000542da:wasm-function[290]:0xed8f
    at wasm://wasm/000542da:wasm-function[297]:0xf11e
    at wasm://wasm/000542da:wasm-function[33]:0x999
    at wasm://wasm/000542da:wasm-function[17]:0x73e
    at wasm://wasm/000542da:wasm-function[18]:0x7af
    at open_noctty.js:615:12
    at callMain (open_noctty.js:1658:15)
    at run (open_noctty.js:1704:22)

Node.js v24.20.0
[exit status 1]
```

The same at `-O2 -sASSERTIONS`:

```
$ emcc -O2 -sASSERTIONS -sWASMFS open_noctty.c -o open_noctty.js && node open_noctty.js > run.log 2>&1; sed -n "/^opening/p; /^open =/p; /^Aborted/p" run.log
opening with O_NOCTTY
Aborted(Assertion failed: (flags & ~(O_CREAT | O_EXCL | O_DIRECTORY | O_TRUNC | O_APPEND | O_RDWR | O_WRONLY | O_RDONLY | O_LARGEFILE | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)) == 0, at: /emsdk/emscripten/system/lib/wasmfs/syscalls.cpp,441,doOpen)
```

Without assertions, under the JS file system, and natively, the open succeeds:

```
$ emcc -O2 -sWASMFS open_noctty.c -o open_noctty.js && node open_noctty.js
opening with O_NOCTTY
open = 3 (no error)
$ emcc -O0 open_noctty.c -o open_noctty.js && node open_noctty.js
opening with O_NOCTTY
open = 3 (no error)
$ cc open_noctty.c -o open_noctty && ./open_noctty
opening with O_NOCTTY
open = 3 (no error)
```

`O_SYNC`, `O_DSYNC` and `O_RSYNC` (all outside the list) trip the same
assertion; only `O_SYNC` was run.

<details>
<summary>Full compile and link output with <code>-v</code> appended (cache and scratch paths shortened)</summary>

```
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/clang -target wasm32-unknown-emscripten -fignore-exceptions -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr --sysroot=$EM_CACHE/sysroot -resource-dir=/nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter$EM_CACHE/sysroot/include -iwithsysroot/include/c++/v1 -Xclang -iwithsysroot/include/fakesdl -Xclang -iwithsysroot/include/compat -v -O0 -c open_noctty.c -o /tmp/emscripten_temp_0ae5kxne/open_noctty.o
clang version 22.1.8
Target: wasm32-unknown-emscripten
Thread model: posix
InstalledDir: /nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin
 (in-process)
 "/nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin/clang-22" -cc1 -triple wasm32-unknown-emscripten -O0 -emit-obj -disable-free -clear-ast-before-backend -disable-llvm-verifier -discard-value-names -main-file-name open_noctty.c -mrelocation-model static -mframe-pointer=none -ffp-contract=on -fno-rounding-math -mconstructor-aliases -target-cpu generic -fvisibility=hidden -debugger-tuning=gdb -fdebug-compilation-dir=. -v -fcoverage-compilation-dir=. -resource-dir /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter $EM_CACHE/sysroot/include -iwithsysroot /include/c++/v1 -isysroot $EM_CACHE/sysroot -internal-isystem /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/include -internal-isystem $EM_CACHE/sysroot/include/wasm32-emscripten -internal-isystem $EM_CACHE/sysroot/include -ferror-limit 19 -fgnuc-version=4.2.1 -fskip-odr-check-in-gmf -fignore-exceptions -iwithsysroot/include/fakesdl -iwithsysroot/include/compat -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr -o /tmp/emscripten_temp_0ae5kxne/open_noctty.o -x c open_noctty.c
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
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/wasm-ld -o open_noctty.wasm /tmp/tmp4shga84glibemscripten_js_symbols.so -Bstatic --strip-debug --export=emscripten_stack_get_end --export=emscripten_stack_get_free --export=emscripten_stack_get_base --export=emscripten_stack_get_current --export=emscripten_stack_init --export=wasmfs_flush --export=_emscripten_stack_alloc --export=__wasm_call_ctors --export=_emscripten_stack_restore --export-if-defined=__start_em_asm --export-if-defined=__stop_em_asm --export-if-defined=__start_em_lib_deps --export-if-defined=__stop_em_lib_deps --export-if-defined=__start_em_js --export-if-defined=__stop_em_js --export-if-defined=main --export-if-defined=__main_argc_argv --export-if-defined=fflush --export-table -z stack-size=65536 --no-growable-memory --initial-heap=16777216 --no-entry --stack-first --table-base=1 /tmp/emscripten_temp_0ae5kxne/open_noctty.o -L$EM_CACHE/sysroot/lib/wasm32-emscripten -L/nix/store/03iyrnrsxnbc64y6r62irmlbnbap5ya2-emscripten-6.0.9/share/emscripten/src/lib -lGL-getprocaddr -lal -lhtml5 -lstubs-debug -lnoexit -lc-debug -ldlmalloc-debug -lclang_rt.builtins -lc++-debug-noexcept -lc++abi-debug-noexcept -lsockets -lwasmfs_no_fs -lwasmfs-debug -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/llvm-objcopy open_noctty.wasm open_noctty.wasm '--remove-section=llvm.func_attr.annotate.*' --remove-section=producers --remove-section=name '--remove-section=.debug*'
```

</details>

**Where:** `doOpen` asserts that the flags fall within a fixed list, under
`// TODO: remove assert when all functionality is complete.`
([syscalls.cpp#L438-L441](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/syscalls.cpp#L438-L441)).

**Suggested fix:** accept `O_NOCTTY`, which WasmFS can always ignore:

```diff
--- a/system/lib/wasmfs/syscalls.cpp
+++ b/system/lib/wasmfs/syscalls.cpp
@@ -438,7 +438,7 @@
   // TODO: remove assert when all functionality is complete.
   assert((flags & ~(O_CREAT | O_EXCL | O_DIRECTORY | O_TRUNC | O_APPEND |
                     O_RDWR | O_WRONLY | O_RDONLY | O_LARGEFILE | O_NOFOLLOW |
-                    O_CLOEXEC | O_NONBLOCK)) == 0);
+                    O_CLOEXEC | O_NONBLOCK | O_NOCTTY)) == 0);

   if (auto err = parsed.getError()) {
     return err;
```

With this applied to 6.0.9, the test case prints:

```
opening with O_NOCTTY
open = 3 (no error)
```

For `O_SYNC`/`O_DSYNC` the choice is less obvious. They could be ignored,
which is fine for the memory backend but not durable on the Node or OPFS
backends. They could flush after each write. Or `open` could fail with
`EINVAL`. Any of these beats an abort that only debug builds hit. More
generally, Linux ignores open flags it doesn't know, so the assertion could
become "ignore unknown flags" outright.

---

## Notes for the user

- **FAQ.** Nothing in the FAQ covers open flags. The FAQ's advice to try `-O0`
  is what exposes this: release builds hide it.
- **bug_reports.rst.** The source, `emcc -v`, the symptoms and a tested fix
  for `O_NOCTTY` are included. Bitcode is left out because the fault is in
  `libwasmfs`. The `O_SYNC` part is left to the maintainers.
- **Duplicate search.** "O_NOCTTY", "O_NOCTTY wasmfs", "doOpen assert",
  "openpty" and "remove assert when all functionality", plus a scan of all open
  "wasmfs" issues, turned up:
  - #11927 and #12492/#12053: NODEFS `O_NOCTTY`, fixed in 2020.
  - #15524: NODERAWFS `tcgetattr`, unrelated.
  - #26728 (merged): `fcntl(F_SETFL)` flag masking, which quotes `O_NOCTTY` in
    the man page but doesn't touch `open`.
  None covers WasmFS's assertion.
- **Why it matters to us.** GLib's `/pollable/unix/pty` calls `openpty()`. musl
  opens `/dev/ptmx` with `O_NOCTTY`, and under `-sASSERTIONS` the test aborts
  instead of failing cleanly. Our GLib test patch skips the subtest. With the
  fix, `openpty()` fails with `ENOENT` (checked: WasmFS has no `/dev/ptmx`), which the
  test could report.
- **Testing.** The fixed run used a 6.0.9 tree with all of this set's
  candidate fixes applied at once.
- **Tip-of-tree.** Checked read-only through the GitHub API on 2026-09-30: the
  assertion is unchanged on `main` (2151200, 139 commits past 6.0.9), at
  `syscalls.cpp:440-443`. `syscalls.cpp` changed only in `fdatasync`'s error
  sign (#27806) and `utimensat`'s timestamp rounding. The latest release,
  6.0.10 (tagged 2026-09-18), matches. The conclusion comes from the diff;
  `main` wasn't rebuilt. Our build is nixpkgs' 6.0.9 with LLVM 22.1.8.
- ibus-web carries this fix as `modules/emscripten/patches/wasmfs-open-noctty.patch`.
