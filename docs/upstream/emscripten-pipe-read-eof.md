# Pipe `read()` at EOF fails with EAGAIN while `poll()` reports POLLHUP

**Posted: don't post again.** The comment below went on #26708 on 2026-10-01; no reply yet, and neither #26708 nor
#22032 has moved since. ibus-web carries the suggested fix as 0022, unchanged; it can follow as a PR, with the assertion
the comment proposes for `test_pipe_pollhup.c`.

Checked against `main` 0479680 (2026-10-12): `PIPEFS.stream_ops.read` still fails with `EAGAIN` at EOF, and 0022 applies
there.

**Draft: do not post as a new issue.** This is already reported as
[#26708](https://github.com/emscripten-core/emscripten/issues/26708) ("read() on a pipe returns -1 instead of 0 after
the write end is closed", open, no comments yet). [#22032](https://github.com/emscripten-core/emscripten/issues/22032)
is the same bug: its reopening comment shows the closed-writer case returning `EAGAIN` on 3.1.54. Post the text below as
a **comment on #26708**. It cites #22032 and suggests closing one as a duplicate of the other.

## Comment for #26708

---

This still reproduces on 6.0.9. Since #27298, `poll()` reports `POLLHUP|POLLIN` on the read end once every write end is
closed, but `read()` still fails with `EAGAIN` there. So `read()` and `poll()` now disagree at EOF. A reader that polls,
sees `POLLIN`, and reads until `read()` returns 0 never gets its EOF. It spins on `EAGAIN` instead. We hit this in
GLib's test suite.

This is also the case in #22032: see the
[reopening comment](https://github.com/emscripten-core/emscripten/issues/22032#issuecomment-2148298075), where the
writer is closed before the read. One of the two could be closed as a duplicate.

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

**Test case** (`pipe_eof.c`):

```c
#include <errno.h>
#include <poll.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(void) {
  int p[2];
  if (pipe(p) != 0) {
    perror("pipe");
    return 1;
  }
  write(p[1], "x", 1);
  close(p[1]);

  char buf[16];
  ssize_t n = read(p[0], buf, sizeof buf);
  printf("read with data:   %zd\n", n);

  struct pollfd pfd = {.fd = p[0], .events = POLLIN};
  int r = poll(&pfd, 1, 0);
  printf("poll at EOF:      %d, revents POLLIN=%d POLLHUP=%d\n", r,
         !!(pfd.revents & POLLIN), !!(pfd.revents & POLLHUP));

  errno = 0;
  n = read(p[0], buf, sizeof buf);
  printf("read at EOF:      %zd (errno %d: %s)\n", n, n < 0 ? errno : 0,
         n < 0 ? strerror(errno) : "-");
  return 0;
}
```

**Failing command line in full:**

```
$ emcc -O0 pipe_eof.c -o pipe_eof.js && node pipe_eof.js
read with data:   1
poll at EOF:      1, revents POLLIN=1 POLLHUP=1
read at EOF:      -1 (errno 6: Resource temporarily unavailable)
```

The result is the same at `-O2` and with `-sNODERAWFS`, which leaves pipes to PIPEFS. Native Linux, for comparison:

```
$ cc pipe_eof.c -o pipe_eof && ./pipe_eof
read with data:   1
poll at EOF:      1, revents POLLIN=0 POLLHUP=1
read at EOF:      0 (errno 0: -)
```

<details>
<summary>Full compile and link output with <code>-v</code> appended (cache and scratch paths shortened)</summary>

```
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/clang -target wasm32-unknown-emscripten -fignore-exceptions -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr --sysroot=$EM_CACHE/sysroot -resource-dir=/nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter$EM_CACHE/sysroot/include -iwithsysroot/include/c++/v1 -Xclang -iwithsysroot/include/fakesdl -Xclang -iwithsysroot/include/compat -v -O0 -c pipe_eof.c -o /tmp/emscripten_temp_psud_rhg/pipe_eof.o
clang version 22.1.8
Target: wasm32-unknown-emscripten
Thread model: posix
InstalledDir: /nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin
 (in-process)
 "/nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin/clang-22" -cc1 -triple wasm32-unknown-emscripten -O0 -emit-obj -disable-free -clear-ast-before-backend -disable-llvm-verifier -discard-value-names -main-file-name pipe_eof.c -mrelocation-model static -mframe-pointer=none -ffp-contract=on -fno-rounding-math -mconstructor-aliases -target-cpu generic -fvisibility=hidden -debugger-tuning=gdb -fdebug-compilation-dir=. -v -fcoverage-compilation-dir=. -resource-dir /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter $EM_CACHE/sysroot/include -iwithsysroot /include/c++/v1 -isysroot $EM_CACHE/sysroot -internal-isystem /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/include -internal-isystem $EM_CACHE/sysroot/include/wasm32-emscripten -internal-isystem $EM_CACHE/sysroot/include -ferror-limit 19 -fgnuc-version=4.2.1 -fskip-odr-check-in-gmf -fignore-exceptions -iwithsysroot/include/fakesdl -iwithsysroot/include/compat -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr -o /tmp/emscripten_temp_psud_rhg/pipe_eof.o -x c pipe_eof.c
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
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/wasm-ld -o pipe_eof.wasm /tmp/tmppazxsz9olibemscripten_js_symbols.so -Bstatic --strip-debug --export=emscripten_stack_get_end --export=emscripten_stack_get_free --export=emscripten_stack_get_base --export=emscripten_stack_get_current --export=emscripten_stack_init --export=_emscripten_stack_alloc --export=__wasm_call_ctors --export=_emscripten_stack_restore --export-if-defined=__start_em_asm --export-if-defined=__stop_em_asm --export-if-defined=__start_em_lib_deps --export-if-defined=__stop_em_lib_deps --export-if-defined=__start_em_js --export-if-defined=__stop_em_js --export-if-defined=main --export-if-defined=__main_argc_argv --export-if-defined=fflush --export-table -z stack-size=65536 --no-growable-memory --initial-heap=16777216 --no-entry --stack-first --table-base=1 /tmp/emscripten_temp_psud_rhg/pipe_eof.o -L$EM_CACHE/sysroot/lib/wasm32-emscripten -L/nix/store/03iyrnrsxnbc64y6r62irmlbnbap5ya2-emscripten-6.0.9/share/emscripten/src/lib -lGL-getprocaddr -lal -lhtml5 -lstubs-debug -lnoexit -lc-debug -ldlmalloc-debug -lclang_rt.builtins -lsockets -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/llvm-objcopy pipe_eof.wasm pipe_eof.wasm '--remove-section=llvm.func_attr.annotate.*' --remove-section=producers --remove-section=name '--remove-section=.debug*'
```

</details>

**Where:** `PIPEFS.stream_ops.read` throws `EAGAIN` whenever the pipe is empty, without looking at `pipe.writeClosed`
([libpipefs.js#L162-L165](https://github.com/emscripten-core/emscripten/blob/6.0.9/src/lib/libpipefs.js#L162-L165)). Its
`poll` already treats `writeClosed` as EOF; the comment there says "readable (read returns 0)"
([libpipefs.js#L112-L116](https://github.com/emscripten-core/emscripten/blob/6.0.9/src/lib/libpipefs.js#L112-L116)).
`test/core/test_pipe_pollhup.c` checks the `poll()` side but never reads at EOF.

**Suggested fix:**

```diff
--- a/src/lib/libpipefs.js
+++ b/src/lib/libpipefs.js
@@ -160,6 +160,10 @@
           return 0;
         }
         if (currentLength == 0) {
+          // With every write end closed the pipe is at EOF.
+          if (pipe.writeClosed) {
+            return 0;
+          }
           // Behave as if the read end is always non-blocking
           throw new FS.ErrnoError({{{ cDefs.EAGAIN }}});
         }
```

With this applied to 6.0.9, the test case prints:

```
read with data:   1
poll at EOF:      1, revents POLLIN=1 POLLHUP=1
read at EOF:      0 (errno 0: -)
```

`test/core/test_pipe_pollhup.c`, `test/unistd/pipe.c` and `test/core/test_pipe_select.c` still pass with the change.
Adding `assert(read(p[0], buf, sizeof(buf)) == 0);` after the drain in `test_pipe_pollhup.c` would cover this.

**WasmFS** has the opposite problem. A WasmFS pipe's `read()` returns 0 whenever the pipe is empty, so the EOF case
above works there. But an empty pipe whose writer is still open also reads as EOF (native gives `EAGAIN`, errno 11), and
`poll()` never reports `POLLHUP`
([syscalls.cpp#L1437-L1438](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/syscalls.cpp#L1437-L1438)
is a TODO for this). `pipe_open_empty.c` reads an empty non-blocking pipe whose writer is still open:

```c
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>
int main(void) {
  int p[2];
  pipe(p);
  fcntl(p[0], F_SETFL, O_NONBLOCK);
  char buf[4];
  errno = 0;
  ssize_t n = read(p[0], buf, sizeof buf);
  printf("empty, writer open: %zd errno %d\n", n, n < 0 ? errno : 0);
}
```

```
$ emcc -O0 -sWASMFS pipe_eof.c -o pipe_eof.js && node pipe_eof.js
read with data:   1
poll at EOF:      0, revents POLLIN=0 POLLHUP=0
read at EOF:      0 (errno 0: -)
$ emcc -O0 -sWASMFS pipe_open_empty.c -o pipe_open_empty.js && node pipe_open_empty.js
empty, writer open: 0 errno 0
```

---

## Evidence

- **FAQ.** Nothing in the FAQ covers pipes or documents this behaviour. Following its "I tried something: why doesn't it
  work?" advice, the case was run at `-O0` (assertions on) as well as `-O2`, with the same result, and the test suite
  was checked for coverage: `test_pipe_pollhup.c` exists but stops short of reading at EOF. `emcc --check` passes; it
  prints only the version line.
- **bug_reports.rst.** It asks for the original source, `emcc -v`, the symptoms and a proposed solution; all are
  included. It also asks for generated bitcode (`.o`/`.bc`). That is left out because the bug is in the JavaScript
  library, not in compiled code; the `.o` or `EMCC_DEBUG=1` temp files can be attached if asked for. The guide prefers a
  pull request: the diff above is tested and could be sent as one.
- **Tip-of-tree.** Checked read-only through the GitHub API on 2026-09-30: `libpipefs.js` is unchanged between 6.0.9 and
  `main` (2151200, 139 commits later), and in the latest release, 6.0.10 (tagged 2026-09-18). The conclusion comes from
  the diff; `main` wasn't rebuilt. Our build is nixpkgs' 6.0.9 with LLVM 22.1.8, not emsdk's LLVM.
- **Duplicate search.** `gh search issues --repo emscripten-core/emscripten --include-prs` with "pipe EOF", "pipe read
  EOF", "pipe POLLHUP", "PIPEFS EAGAIN", "pipe EAGAIN EOF", "pipe read returns 0 writer closed" and "pipe" turned up:
  - #26708, the exact bug: reported on 5.0.6, open.
  - #27298 (merged), which added the `POLLHUP` that makes the disagreement visible. Its description says "read returns
    EOF", but it doesn't change `read`.
  - #22032 ("Got Resource temporarily unavailable when reading empty pipe", 3.1.54, reopened). It opened as the
    empty-pipe/writer-open case, which a maintainer called a duplicate of #22029, but the reopening comment by hly2019
    is exactly this EOF case. The comment cites it and suggests closing one as a duplicate.
  - #13214 ("pipe() doesn't create a blocking pipe") and #27683 ("Pipe read() never blocks, and poll() ignores
    timeouts"). These are about blocking on an empty pipe whose writer is still open, which is a different issue.
- **Linux detail left out of the comment.** Linux reports only `POLLHUP` (not `POLLIN`) on an empty pipe at EOF, as the
  native output shows. Emscripten's `POLLHUP|POLLIN` is deliberate (#27298) and harmless, so the comment doesn't raise
  it.
- **Other WasmFS pipe gaps** are drafted separately: `emscripten-wasmfs-pipe-fifo-mode.md` (pipes report `S_IFREG`) and
  `emscripten-pipe-capacity.md` (pipes have no capacity).
- ibus-web carries this fix as `modules/emscripten/patches/0022-pipe-read-eof.patch`; `checks.emscripten-fixes` reads a
  pipe to its end on PIPEFS (under NODERAWFS) and on WasmFS. WasmFS's own behaviour, an empty pipe reading 0 while a
  writer is open, is left as it is: GLib's `test-printf` still waits for its writer before reading.
