# WasmFS: `poll()` reports an empty regular file as not readable

**Draft: new issue.** No existing issue covers it. #20615 ("WasmFS: real
poll/select support") and #26736 ("WASMFS missing support for blocking
select/poll") are about blocking and timeouts, not readiness of regular files.

## Issue title

WasmFS: poll() does not report POLLIN for an empty regular file

## Issue body

---

POSIX says regular files always poll true for reading and writing. Under
WasmFS, `poll()` only sets `POLLIN` on a regular file when the file is non-empty.
A caller that polls before reading, such as an event loop watching a file
descriptor, waits forever on an empty file instead of reading EOF.

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

**Test case** (`poll_empty_file.c`):

```c
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <unistd.h>

static void probe(const char *label, int fd) {
  struct pollfd pfd = {.fd = fd, .events = POLLIN | POLLOUT};
  int r = poll(&pfd, 1, 0);
  printf("%-28s poll=%d POLLIN=%d POLLOUT=%d\n", label, r,
         !!(pfd.revents & POLLIN), !!(pfd.revents & POLLOUT));
}

int main(void) {
  int fd = open("/tmp/empty", O_CREAT | O_RDWR | O_TRUNC, 0666);
  probe("empty file", fd);
  write(fd, "x", 1);
  probe("1-byte file, offset 1", fd);
  close(fd);
  return 0;
}
```

**Failing command line in full** (the same at `-O2`):

```
$ emcc -O0 -sWASMFS poll_empty_file.c -o poll_empty_file.js && node poll_empty_file.js
empty file                   poll=1 POLLIN=0 POLLOUT=1
1-byte file, offset 1        poll=1 POLLIN=1 POLLOUT=1
```

The JS file system and native Linux both report `POLLIN`:

```
$ emcc -O0 poll_empty_file.c -o poll_empty_file.js && node poll_empty_file.js
empty file                   poll=1 POLLIN=1 POLLOUT=1
1-byte file, offset 1        poll=1 POLLIN=1 POLLOUT=1
$ cc poll_empty_file.c -o poll_empty_file && ./poll_empty_file
empty file                   poll=1 POLLIN=1 POLLOUT=1
1-byte file, offset 1        poll=1 POLLIN=1 POLLOUT=1
```

<details>
<summary>Full compile and link output with <code>-v</code> appended (cache and scratch paths shortened)</summary>

```
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/clang -target wasm32-unknown-emscripten -fignore-exceptions -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr --sysroot=$EM_CACHE/sysroot -resource-dir=/nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter$EM_CACHE/sysroot/include -iwithsysroot/include/c++/v1 -Xclang -iwithsysroot/include/fakesdl -Xclang -iwithsysroot/include/compat -v -O0 -c poll_empty_file.c -o /tmp/emscripten_temp_1w03akc9/poll_empty_file.o
clang version 22.1.8
Target: wasm32-unknown-emscripten
Thread model: posix
InstalledDir: /nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin
 (in-process)
 "/nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin/clang-22" -cc1 -triple wasm32-unknown-emscripten -O0 -emit-obj -disable-free -clear-ast-before-backend -disable-llvm-verifier -discard-value-names -main-file-name poll_empty_file.c -mrelocation-model static -mframe-pointer=none -ffp-contract=on -fno-rounding-math -mconstructor-aliases -target-cpu generic -fvisibility=hidden -debugger-tuning=gdb -fdebug-compilation-dir=. -v -fcoverage-compilation-dir=. -resource-dir /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter $EM_CACHE/sysroot/include -iwithsysroot /include/c++/v1 -isysroot $EM_CACHE/sysroot -internal-isystem /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/include -internal-isystem $EM_CACHE/sysroot/include/wasm32-emscripten -internal-isystem $EM_CACHE/sysroot/include -ferror-limit 19 -fgnuc-version=4.2.1 -fskip-odr-check-in-gmf -fignore-exceptions -iwithsysroot/include/fakesdl -iwithsysroot/include/compat -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr -o /tmp/emscripten_temp_1w03akc9/poll_empty_file.o -x c poll_empty_file.c
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
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/wasm-ld -o poll_empty_file.wasm /tmp/tmpm7ogbk2slibemscripten_js_symbols.so -Bstatic --strip-debug --export=emscripten_stack_get_end --export=emscripten_stack_get_free --export=emscripten_stack_get_base --export=emscripten_stack_get_current --export=emscripten_stack_init --export=wasmfs_flush --export=_emscripten_stack_alloc --export=__wasm_call_ctors --export=_emscripten_stack_restore --export-if-defined=__start_em_asm --export-if-defined=__stop_em_asm --export-if-defined=__start_em_lib_deps --export-if-defined=__stop_em_lib_deps --export-if-defined=__start_em_js --export-if-defined=__stop_em_js --export-if-defined=main --export-if-defined=__main_argc_argv --export-if-defined=fflush --export-table -z stack-size=65536 --no-growable-memory --initial-heap=16777216 --no-entry --stack-first --table-base=1 /tmp/emscripten_temp_1w03akc9/poll_empty_file.o -L$EM_CACHE/sysroot/lib/wasm32-emscripten -L/nix/store/03iyrnrsxnbc64y6r62irmlbnbap5ya2-emscripten-6.0.9/share/emscripten/src/lib -lGL-getprocaddr -lal -lhtml5 -lstubs-debug -lnoexit -lc-debug -ldlmalloc-debug -lclang_rt.builtins -lc++-debug-noexcept -lc++abi-debug-noexcept -lsockets -lwasmfs_no_fs -lwasmfs-debug -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/llvm-objcopy poll_empty_file.wasm poll_empty_file.wasm '--remove-section=llvm.func_attr.annotate.*' --remove-section=producers --remove-section=name '--remove-section=.debug*'
```

</details>

**Where:** `__syscall_poll` sets `POLLIN` only when `getSize() > 0`
([syscalls.cpp#L1425-L1434](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/syscalls.cpp#L1425-L1434)).
That suits a pipe (a WasmFS pipe's size is its queued byte count), but not a
regular file.

**Suggested fix:** treat seekable data files as always readable and keep the
size test for pipes, which are WasmFS's non-seekable data files:

```diff
--- a/system/lib/wasmfs/syscalls.cpp
+++ b/system/lib/wasmfs/syscalls.cpp
@@ -1428,7 +1428,9 @@
         // TODO: Does this need to consider the position as well? That is, if
         // the position is at the end, we can't read from the current position
         // at least. If we update this, make sure the size isn't an error!
-        if (openFile->locked().getFile()->locked().getSize() > 0) {
+        auto file = openFile->locked().getFile();
+        // Regular files are always readable; pipes only when data is queued.
+        if (file->isSeekable() || file->locked().getSize() > 0) {
           mask |= writeBit;
         }
       }
```

With this applied to 6.0.9, the test case prints:

```
empty file                   poll=1 POLLIN=1 POLLOUT=1
1-byte file, offset 1        poll=1 POLLIN=1 POLLOUT=1
```

An empty WasmFS pipe still polls as not readable. (Checked with a pipe at EOF;
WasmFS pipes are `DataFile`s too, so they reach the same check.) This also
answers the TODO above the check: for a regular file, the position doesn't
matter either.

---

## Notes for the user

- **FAQ.** Nothing in the FAQ covers `poll` or WasmFS readiness. Run at `-O0`
  and `-O2`, with the same result. No test in `test/` polls a regular file under
  WasmFS.
- **bug_reports.rst.** The source, `emcc -v`, the symptoms and a tested fix are
  included. Bitcode is left out because the fault is in `libwasmfs`.
- **Alternative fix.** The TODO at `syscalls.cpp:1435` suggests a per-file
  `poll()` hook. That would be the cleaner design (pipes could then report
  `POLLHUP` too, see `emscripten-pipe-read-eof.md`), but it's a larger change
  for maintainers to choose.
- **Duplicate search.** "wasmfs poll", "wasmfs poll regular file", "poll
  regular file POLLIN", "poll empty file", "poll returns 0 for file", "poll
  regular", "select regular file wasmfs" and "poll", plus a scan of all open
  "wasmfs" issues, turned up #20615, #26736, #25759, #27683, #19447 and #16704,
  all about blocking or sockets. None is this bug.
- **Why it matters to us.** GLib's `/mainloop/nfds` watches an empty temp file
  through a `GIOChannel` and expects its source to dispatch. On WasmFS it never
  does. Our GLib test patch works around it by writing one byte to the file first. The
  body says "an event loop watching a file descriptor" without naming GLib; add
  the name if it helps.
- **Not verified on tip-of-tree or emsdk's latest release.** The build is
  nixpkgs' 6.0.9 with LLVM 22.1.8.
