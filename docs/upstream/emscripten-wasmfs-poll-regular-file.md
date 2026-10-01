# WasmFS: `poll()` reports empty regular files and devices as not readable

**Draft: new issue.** No existing issue covers it. #20615 ("WasmFS: real
poll/select support") and #26736 ("WASMFS missing support for blocking
select/poll") are about blocking and timeouts, not readiness.

## Issue title

WasmFS: poll() does not report POLLIN for an empty regular file, /dev/null or /dev/random

## Issue body

---

POSIX says regular files always poll true for reading and writing, and Linux
reports `/dev/null` and `/dev/random` readable too. Under WasmFS, `poll()` sets
`POLLIN` on a data file only when its size is non-zero. So an empty regular
file, `/dev/null` and `/dev/random` (whose sizes are always 0) never poll
readable. A caller that polls before reading, such as an event loop watching a
file descriptor, waits forever instead of reading EOF or random bytes.

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
  struct pollfd pfd = {.fd = fd, .events = POLLIN};
  int r = poll(&pfd, 1, 0);
  printf("%-24s poll=%d POLLIN=%d\n", label, r, !!(pfd.revents & POLLIN));
}

int main(void) {
  int fd = open("/tmp/empty", O_CREAT | O_RDWR | O_TRUNC, 0644);
  probe("empty file", fd);
  write(fd, "x", 1);
  probe("1-byte file, offset 1", fd);
  close(fd);

  fd = open("/dev/null", O_RDONLY);
  probe("/dev/null", fd);
  close(fd);
  fd = open("/dev/random", O_RDONLY);
  probe("/dev/random", fd);
  close(fd);
  return 0;
}
```

**Failing command line in full** (the same at `-O2`):

```
$ emcc -O0 -sWASMFS poll_empty_file.c -o poll_empty_file.js && node poll_empty_file.js
empty file               poll=0 POLLIN=0
1-byte file, offset 1    poll=1 POLLIN=1
/dev/null                poll=0 POLLIN=0
/dev/random              poll=0 POLLIN=0
```

The JS file system and native Linux both report `POLLIN` for all four:

```
$ emcc -O0 poll_empty_file.c -o poll_empty_file.js && node poll_empty_file.js
empty file               poll=1 POLLIN=1
1-byte file, offset 1    poll=1 POLLIN=1
/dev/null                poll=1 POLLIN=1
/dev/random              poll=1 POLLIN=1
$ cc poll_empty_file.c -o poll_empty_file && ./poll_empty_file
empty file               poll=1 POLLIN=1
1-byte file, offset 1    poll=1 POLLIN=1
/dev/null                poll=1 POLLIN=1
/dev/random              poll=1 POLLIN=1
```

<details>
<summary>Full compile and link output with <code>-v</code> appended (cache and scratch paths shortened)</summary>

```
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/clang -target wasm32-unknown-emscripten -fignore-exceptions -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr --sysroot=$EM_CACHE/sysroot -resource-dir=/nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter$EM_CACHE/sysroot/include -iwithsysroot/include/c++/v1 -Xclang -iwithsysroot/include/fakesdl -Xclang -iwithsysroot/include/compat -v -O0 -c poll_empty_file.c -o /tmp/emscripten_temp_ueknpd59/poll_empty_file.o
clang version 22.1.8
Target: wasm32-unknown-emscripten
Thread model: posix
InstalledDir: /nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin
 (in-process)
 "/nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin/clang-22" -cc1 -triple wasm32-unknown-emscripten -O0 -emit-obj -disable-free -clear-ast-before-backend -disable-llvm-verifier -discard-value-names -main-file-name poll_empty_file.c -mrelocation-model static -mframe-pointer=none -ffp-contract=on -fno-rounding-math -mconstructor-aliases -target-cpu generic -fvisibility=hidden -debugger-tuning=gdb -fdebug-compilation-dir=. -v -fcoverage-compilation-dir=. -resource-dir /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter $EM_CACHE/sysroot/include -iwithsysroot /include/c++/v1 -isysroot $EM_CACHE/sysroot -internal-isystem /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/include -internal-isystem $EM_CACHE/sysroot/include/wasm32-emscripten -internal-isystem $EM_CACHE/sysroot/include -ferror-limit 19 -fgnuc-version=4.2.1 -fskip-odr-check-in-gmf -fignore-exceptions -iwithsysroot/include/fakesdl -iwithsysroot/include/compat -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr -o /tmp/emscripten_temp_ueknpd59/poll_empty_file.o -x c poll_empty_file.c
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
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/wasm-ld -o poll_empty_file.wasm /tmp/tmp0vih244slibemscripten_js_symbols.so -Bstatic --strip-debug --export=emscripten_stack_get_end --export=emscripten_stack_get_free --export=emscripten_stack_get_base --export=emscripten_stack_get_current --export=emscripten_stack_init --export=wasmfs_flush --export=_emscripten_stack_alloc --export=__wasm_call_ctors --export=_emscripten_stack_restore --export-if-defined=__start_em_asm --export-if-defined=__stop_em_asm --export-if-defined=__start_em_lib_deps --export-if-defined=__stop_em_lib_deps --export-if-defined=__start_em_js --export-if-defined=__stop_em_js --export-if-defined=main --export-if-defined=__main_argc_argv --export-if-defined=fflush --export-table -z stack-size=65536 --no-growable-memory --initial-heap=16777216 --no-entry --stack-first --table-base=1 /tmp/emscripten_temp_ueknpd59/poll_empty_file.o -L$EM_CACHE/sysroot/lib/wasm32-emscripten -L/nix/store/03iyrnrsxnbc64y6r62irmlbnbap5ya2-emscripten-6.0.9/share/emscripten/src/lib -lGL-getprocaddr -lal -lhtml5 -lstubs-debug -lnoexit -lc-debug -ldlmalloc-debug -lclang_rt.builtins -lc++-debug-noexcept -lc++abi-debug-noexcept -lsockets -lwasmfs_no_fs -lwasmfs-debug -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/llvm-objcopy poll_empty_file.wasm poll_empty_file.wasm '--remove-section=llvm.func_attr.annotate.*' --remove-section=producers --remove-section=name '--remove-section=.debug*'
```

</details>

**Where:** `__syscall_poll` sets `POLLIN` only when `getSize() > 0`
([syscalls.cpp#L1425-L1434](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/syscalls.cpp#L1425-L1434)).
That suits a pipe, whose size is its queued byte count, but no other data file.
`NullFile` and `RandomFile` always report size 0
([special_files.cpp](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/special_files.cpp)).
Seekability doesn't separate pipes from the rest either: stdin, stdout, stderr
and `/dev/random` are non-seekable too
([special_files.cpp#L64](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/special_files.cpp#L64),
[#L110](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/special_files.cpp#L110),
[#L166](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/special_files.cpp#L166)).

**Suggested fix:** the per-file readiness hook the TODO at
[syscalls.cpp#L1435](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/syscalls.cpp#L1435)
suggests. Data files are readable by default; only pipes override it:

```diff
--- a/system/lib/wasmfs/file.h
+++ b/system/lib/wasmfs/file.h
@@ -152,6 +152,10 @@
   // on success or a negative error code.
   virtual int flush() = 0;

+  // Whether poll() should report the file readable. Files whose readiness can
+  // change, like pipes, override this.
+  virtual bool isReadReady() { return true; }
+
 public:
   static constexpr FileKind expectedKind = File::DataFileKind;
   DataFile(mode_t mode, backend_t backend)
@@ -366,6 +370,8 @@

   [[nodiscard]] int setSize(off_t size) { return getFile()->setSize(size); }

+  bool isReadReady() { return getFile()->isReadReady(); }
+
   // TODO: Design a proper API for flushing files.
   [[nodiscard]] int flush() { return getFile()->flush(); }

--- a/system/lib/wasmfs/pipe_backend.h
+++ b/system/lib/wasmfs/pipe_backend.h
@@ -46,6 +46,8 @@

   int flush() override { return 0; }

+  bool isReadReady() override { return !data->empty(); }
+
   off_t getSize() override { return data->size(); }

   // TODO: Should this return an error?
--- a/system/lib/wasmfs/syscalls.cpp
+++ b/system/lib/wasmfs/syscalls.cpp
@@ -1428,7 +1428,8 @@
         // TODO: Does this need to consider the position as well? That is, if
         // the position is at the end, we can't read from the current position
         // at least. If we update this, make sure the size isn't an error!
-        if (openFile->locked().getFile()->locked().getSize() > 0) {
+        auto dataFile = openFile->locked().getFile()->dynCast<DataFile>();
+        if (!dataFile || dataFile->locked().isReadReady()) {
           mask |= writeBit;
         }
       }
```

With this applied to 6.0.9, the test case prints:

```
empty file               poll=1 POLLIN=1
1-byte file, offset 1    poll=1 POLLIN=1
/dev/null                poll=1 POLLIN=1
/dev/random              poll=1 POLLIN=1
```

Pipes keep their behaviour (`pipe_poll.c` polls an empty pipe, then one with a
byte in it):

```
empty pipe           POLLIN=0
pipe with data       POLLIN=1
```

One thing changes beyond the test case. Stdin never polled readable before
(size 0); now it always does, since `StdinFile` keeps the default. That matches
the JS file system, where TTY streams have no poll handler and so report
`POLLIN|POLLOUT`
([libsyscall.js#L611-L613](https://github.com/emscripten-core/emscripten/blob/6.0.9/src/lib/libsyscall.js#L611-L613)).
The consequence: a poll-driven loop that watches stdin will now go on to read
it. That read is synchronous: a blocking `fs.readSync` under Node, and
`window.prompt()` in a browser. If that's unwanted, `StdinFile` can override
the hook to return false.

The hook also answers the TODO above the check: for a regular file, the
position doesn't matter. A similar hook could later let pipes report
`POLLHUP`.

---

## Notes for the user

- **Scope.** Covers everything the plan's bullet lists: empty regular files,
  `/dev/null` and `/dev/random`. Stdin, stdout and stderr fall under the
  default (readable). That's a judgement call the body states openly; it was
  not tested against a terminal. Directories were already readable (their size
  is 4096), and still are.
- **Testing.** The fixed run used a 6.0.9 tree with all of this set's
  candidate fixes applied at once, including the pipe `S_IFIFO` change.
  `test/core/test_pipe_pollhup.c`, `test/unistd/pipe.c` and
  `test/core/test_pipe_select.c` gave the same results with and without the
  patch, under the JS FS and under WasmFS. The `test/wasmfs/*.c` programs also
  matched, apart from wasm offsets in stack traces of tests that already fail
  outside the harness.
- **FAQ.** Nothing in the FAQ covers `poll` or WasmFS readiness. Run at `-O0`
  and `-O2`, with the same result. No test in `test/` polls a regular file or a
  device under WasmFS.
- **bug_reports.rst.** The source, `emcc -v`, the symptoms and a tested fix are
  included. Bitcode is left out because the fault is in `libwasmfs`.
- **Duplicate search.** "wasmfs poll", "wasmfs poll regular file", "poll
  regular file POLLIN", "poll empty file", "poll returns 0 for file", "poll
  regular", "select regular file wasmfs" and "poll", plus a scan of all open
  "wasmfs" issues, turned up #20615, #26736, #25759, #27683, #19447 and #16704,
  all about blocking or sockets. None is this bug.
- **Why it matters to us.** GLib's `/mainloop/nfds` watches an empty temp file
  through a `GIOChannel`; our GLib test patch writes one byte first to get
  around this. `/mainloop/unix-file-poll`, `/mainloop/unix-fd-priority` and
  `/closure/fd` skip on WebAssembly because `/dev/null` and `/dev/random` never
  poll readable. The body says "an event loop watching a file descriptor"
  without naming GLib; add the name if it helps.
- **Tip-of-tree.** Checked read-only through the GitHub API on 2026-09-30:
  `file.h`, `pipe_backend.h` and `special_files.cpp` are unchanged between 6.0.9
  and `main` (2151200, 139 commits later). `syscalls.cpp` changed only in
  `fdatasync`'s error sign (#27806) and `utimensat`'s timestamp rounding; the
  cited code is unchanged, a few lines further down. The latest release, 6.0.10
  (tagged 2026-09-18), matches. The conclusion comes from the diff; `main`
  wasn't rebuilt. Our build is nixpkgs' 6.0.9 with LLVM 22.1.8.
- ibus-web carries this fix as `modules/emscripten/patches/0003-wasmfs-poll-regular-file.patch`.
