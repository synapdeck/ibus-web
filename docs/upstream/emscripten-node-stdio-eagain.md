# Node: output is cut short or fails with `EAGAIN` once a pthread's Worker exists

**Still to post.** No issue or PR covers it (searches on 2026-10-09, under "Evidence"). Post the issue below, then the
fix as a PR with the test in `emscripten-node-stdio-eagain.tests.patch`.

Checked against `main` ac0c905 (2026-10-09, after 6.0.12): the four `fs.writeSync()` calls are unchanged but for
`main`'s switch to `!==` and `===`, so 0020 doesn't apply there as it is; the diff under "Suggested fix" is 0020 rebased
onto `main`, and the tests patch applies to `main`'s `test/test_other.py`. Neither was run on `main`: the suite-format
test ran with Emscripten's runner on 6.0.9 carrying ibus-web's stack, using nixpkgs' LLVM 22.1.8, Binaryen 132 and Node
24.21.0. All seven variants fail with 0001–0019 and pass with 0020 added.

**Draft: new issue, with a PR.**

## Issue title

Node + pthreads: output is cut short or aborts with EAGAIN when the reader of a stdout pipe falls behind

## Issue body

---

Under Node, a program built with `-pthread` loses output written to a pipe on stdout or stderr once the reader falls 64
KiB behind: a long line is cut short, or the program dies with `EAGAIN` from `fs.writeSync`. Under `-sNODERAWFS`,
`write()` fails with `EAGAIN` instead and the output is dropped without a word. A program writing to a file or a
terminal, or one whose reader keeps up, is unaffected, so in practice it comes and goes: we hit it as truncated test
output under load.

Node makes a pipe or socket under stdout or stderr non-blocking as soon as it opens `process.stdout` or `process.stderr`
on it, and constructing a `Worker` does that, to forward the Worker's stdio (with the default `stdout: false` and
`stderr: false`). The pthread pool constructs its Workers before `main()`, so every write from then on goes to a
non-blocking descriptor. Plain Node shows it, 24.21.0 and 26.10.0 alike:

```
$ node -e "require('fs').writeSync(1, Buffer.alloc(1 << 20))" | (sleep 1; wc -c)
1048576
$ node -e "new (require('worker_threads').Worker)('', { eval: true }); console.error(require('fs').writeSync(1, Buffer.alloc(1 << 20)))" | (sleep 1; wc -c)
65536
65536
$ node -e "new (require('worker_threads').Worker)('', { eval: true, stdout: true, stderr: true }); console.error(require('fs').writeSync(1, Buffer.alloc(1 << 20)))" | (sleep 1; wc -c)
1048576
1048576
```

Reading `process.stdout` alone does the same, so under `-sNODERAWFS`, whose writes always go through `fs.writeSync`, a
program without threads is hit too once anything in the process touches `process.stdout`: with a `--pre-js` of just
`process.stdout;`, the test case below stops after 65536 bytes with status 0.

**Version of emscripten/emsdk:**

```
emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 6.0.9-git
clang version 22.1.8
Target: wasm32-unknown-emscripten
Thread model: posix
InstalledDir: /nix/store/w3ifgwjmsvy8dwlfir4i4jz17kzxr1xb-clang-22.1.8/bin
```

This is the 6.0.9 release tag as packaged by nixpkgs, with fixes of ours that don't touch the code involved. nixpkgs
builds it against its own LLVM 22.1.8, so there is no commit hash. Node.js v26.10.0, x86_64 Linux.

**Test case** (`stdio_slow_reader.c`):

```c
#include <stdio.h>
#include <string.h>

int main(void) {
  static char line[1024 * 1024 + 1];
  memset(line, 'x', sizeof line - 1);
  puts(line);
  printf("last line\n");
  fprintf(stderr, "done\n");
  return 0;
}
```

**Failing command line in full** (the reader sleeps a second before it reads anything):

```
$ emcc -O0 -pthread -sPTHREAD_POOL_SIZE=1 stdio_slow_reader.c -o stdio_slow_reader.js && node stdio_slow_reader.js | (sleep 1; wc -c)
node:fs:1233
  handleErrorFromBinding(ctx);
  ^

Error: EAGAIN: resource temporarily unavailable, write
    at Object.writeSync (node:fs:1233:3)
    at defaultPrint (stdio_slow_reader.js:250:34)
    at printChar (stdio_slow_reader.js:2044:35)
    at _fd_write (stdio_slow_reader.js:2074:11)
    at wasm://wasm/0002e276:wasm-function[201]:0x3fed
    at wasm://wasm/0002e276:wasm-function[194]:0x3d04
    at wasm://wasm/0002e276:wasm-function[228]:0x5680
    at wasm://wasm/0002e276:wasm-function[227]:0x4d4c
    at wasm://wasm/0002e276:wasm-function[226]:0x4bbf
    at wasm://wasm/0002e276:wasm-function[235]:0x5ad5 {
  errno: -11,
  syscall: 'write',
  code: 'EAGAIN'
}

Node.js v26.10.0
65536
```

The first 64 KiB of the line arrive, and the program exits with status 1; the same at `-O2`. Expected: all 1,048,587
bytes, and `done` on stderr, which is what the same program prints without a pool (`-pthread` alone, which starts no
Worker before `main()`). With `-sNODERAWFS -sFORCE_FILESYSTEM` added, it prints `done` and exits with status 0 having
written 65536 bytes: `write()` failed with `EAGAIN`, which `puts()` reports only through `ferror()`.

<details>
<summary>Full compile and link output with <code>-v</code> appended (cache and scratch paths shortened)</summary>

```
 /nix/store/3mi71c33sdw725i15lxk141m3wx6dsl8-emscripten-llvm-6.0.9/bin/clang -target wasm32-unknown-emscripten -fignore-exceptions -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr --sysroot=$EM_CACHE/sysroot -resource-dir=/nix/store/3mi71c33sdw725i15lxk141m3wx6dsl8-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter$EM_CACHE/sysroot/include -iwithsysroot/include/c++/v1 -D__EMSCRIPTEN_SHARED_MEMORY__=1 -Xclang -iwithsysroot/include/fakesdl -Xclang -iwithsysroot/include/compat -O0 -pthread -v -c stdio_slow_reader.c -o /tmp/emscripten_temp_XXXXXXXX/stdio_slow_reader.o
clang version 22.1.8
Target: wasm32-unknown-emscripten
Thread model: posix
InstalledDir: /nix/store/w3ifgwjmsvy8dwlfir4i4jz17kzxr1xb-clang-22.1.8/bin
 (in-process)
 "/nix/store/w3ifgwjmsvy8dwlfir4i4jz17kzxr1xb-clang-22.1.8/bin/clang-22" -cc1 -triple wasm32-unknown-emscripten -O0 -emit-obj -disable-free -clear-ast-before-backend -disable-llvm-verifier -discard-value-names -main-file-name stdio_slow_reader.c -mrelocation-model static -mframe-pointer=none -ffp-contract=on -fno-rounding-math -mconstructor-aliases -target-feature +atomics -target-feature +bulk-memory -target-feature +mutable-globals -target-feature +sign-ext -target-cpu generic -fvisibility=hidden -debugger-tuning=gdb -fdebug-compilation-dir=. -v -fcoverage-compilation-dir=. -resource-dir /nix/store/3mi71c33sdw725i15lxk141m3wx6dsl8-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter $EM_CACHE/sysroot/include -iwithsysroot /include/c++/v1 -D __EMSCRIPTEN_SHARED_MEMORY__=1 -isysroot $EM_CACHE/sysroot -internal-isystem /nix/store/3mi71c33sdw725i15lxk141m3wx6dsl8-emscripten-llvm-6.0.9/lib/clang/22/include -internal-isystem $EM_CACHE/sysroot/include/wasm32-emscripten -internal-isystem $EM_CACHE/sysroot/include -ferror-limit 19 -pthread -fgnuc-version=4.2.1 -fskip-odr-check-in-gmf -fignore-exceptions -iwithsysroot/include/fakesdl -iwithsysroot/include/compat -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr -o /tmp/emscripten_temp_XXXXXXXX/stdio_slow_reader.o -x c stdio_slow_reader.c
clang -cc1 version 22.1.8 based upon LLVM 22.1.8 default target x86_64-unknown-linux-gnu
ignoring nonexistent directory "$EM_CACHE/sysroot/include/wasm32-emscripten"
ignoring duplicate directory "$EM_CACHE/sysroot/include"
#include "..." search starts here:
#include <...> search starts here:
 $EM_CACHE/sysroot/include/c++/v1
 $EM_CACHE/sysroot/include/fakesdl
 $EM_CACHE/sysroot/include/compat
 /nix/store/3mi71c33sdw725i15lxk141m3wx6dsl8-emscripten-llvm-6.0.9/lib/clang/22/include
 $EM_CACHE/sysroot/include
End of search list.
 /nix/store/3mi71c33sdw725i15lxk141m3wx6dsl8-emscripten-llvm-6.0.9/bin/clang --version
 /nix/store/gxq2cd70i077rah1d4hkzc1lpq8q4pv8-nodejs-24.21.0/bin/node /nix/store/j5h4zh34y4g02wv3abij7h5dwk8alqj3-emscripten-6.0.9/share/emscripten/tools/compiler.mjs - --symbols-only
 /nix/store/3mi71c33sdw725i15lxk141m3wx6dsl8-emscripten-llvm-6.0.9/bin/wasm-ld -o stdio_slow_reader.wasm /tmp/tmpXXXXXXXXlibemscripten_js_symbols.so -Bstatic --import-memory --shared-memory --strip-debug --export=emscripten_stack_get_end --export=emscripten_stack_get_free --export=emscripten_stack_get_base --export=emscripten_stack_get_current --export=emscripten_stack_init --export=_emscripten_stack_alloc --export=_emscripten_thread_free_data --export=_emscripten_thread_crashed --export=__wasm_call_ctors --export=_emscripten_tls_init --export=_emscripten_thread_init --export=_emscripten_thread_run_deferred_cleanups --export=pthread_self --export=__set_thread_state --export=_emscripten_stack_restore --export=emscripten_stack_set_limits --export=_emscripten_thread_exit --export-if-defined=__start_em_asm --export-if-defined=__stop_em_asm --export-if-defined=__start_em_lib_deps --export-if-defined=__stop_em_lib_deps --export-if-defined=__start_em_js --export-if-defined=__stop_em_js --export-if-defined=main --export-if-defined=__main_argc_argv --export-if-defined=fflush --export-table -z stack-size=65536 --no-growable-memory --initial-memory=16777216 --no-entry --stack-first --table-base=1 /tmp/emscripten_temp_XXXXXXXX/stdio_slow_reader.o -L$EM_CACHE/sysroot/lib/wasm32-emscripten -L/nix/store/j5h4zh34y4g02wv3abij7h5dwk8alqj3-emscripten-6.0.9/share/emscripten/src/lib $EM_CACHE/sysroot/lib/wasm32-emscripten/crtbegin-mt.o -lGL-mt-getprocaddr -lal -lhtml5 -lstubs-debug -lnoexit -lc-mt-debug -ldlmalloc-mt-debug -lclang_rt.builtins-mt -lsockets-mt -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr
 /nix/store/3mi71c33sdw725i15lxk141m3wx6dsl8-emscripten-llvm-6.0.9/bin/llvm-objcopy stdio_slow_reader.wasm stdio_slow_reader.wasm '--remove-section=llvm.func_attr.annotate.*' --remove-section=producers --remove-section=name '--remove-section=.debug*'
 /nix/store/gxq2cd70i077rah1d4hkzc1lpq8q4pv8-nodejs-24.21.0/bin/node /nix/store/j5h4zh34y4g02wv3abij7h5dwk8alqj3-emscripten-6.0.9/share/emscripten/tools/compiler.mjs -
```

</details>

**Where:** every synchronous write Emscripten makes to fds 1 and 2 under Node.

- `out()` and `err()` with threads: `defaultPrint` and `defaultPrintErr` call `fs.writeSync(1, string)` (or `2`) once
  and ignore the count it returns
  ([shell.js#L344-L345](https://github.com/emscripten-core/emscripten/blob/6.0.9/src/shell.js#L344-L345),
  [shell_minimal.js#L108-L109](https://github.com/emscripten-core/emscripten/blob/6.0.9/src/shell_minimal.js#L108-L109)).
  They carry `printf()` on every file system: the TTY's `put_char`, `printChar` without a file system, and WasmFS's
  stdout and stderr through `emscripten_out()` and `emscripten_err()`. A pthread's Worker under Node has its own
  `defaultPrint`, whose `fs.writeSync(1, …)` reaches the process's fd 1, unless the program supplies `print` or
  `printErr`.
- `dbg()` ([runtime_debug.js#L27](https://github.com/emscripten-core/emscripten/blob/6.0.9/src/runtime_debug.js#L27)).
- NODERAWFS's `write`, on its standard streams, whose `nfd` is the process's 0, 1 or 2
  ([libnoderawfs.js#L259](https://github.com/emscripten-core/emscripten/blob/6.0.9/src/lib/libnoderawfs.js#L259)).
- The Workers are constructed with `pthreadWorkerOptions`, which leave `stdout` and `stderr` at their defaults
  ([libpthread.js#L54](https://github.com/emscripten-core/emscripten/blob/6.0.9/src/lib/libpthread.js#L54)).

#17962 met the same thing in `acorn-optimizer.js` ("we can get partial writes, but even adding a loop can fail with
EAGAIN") and went back to `process.stdout.write()`. That can't work here: the runtime's output has to get out while the
main thread is blocked, which is why #14805 moved it to `fs.writeSync()` for #14804.

**Suggested fix:** wait for the reader. `out()` and `err()` write their whole line, and NODERAWFS retries a write that
fails with `EAGAIN` unless the program set `O_NONBLOCK` on that stream itself (`fcntl(F_SETFL)` only changes the
stream's flags, so a program that asked for non-blocking output still gets `EAGAIN`). Node has no synchronous way to
wait for a descriptor to become writable, so both sleep 1 ms with `Atomics.wait()` between tries, which works on the
main thread and on a Worker alike. Each line's first write passes the string itself, so a write that goes through whole
calls `fs.writeSync()` as it does today, and only a short write pays for encoding the string to resume part-way.

The alternatives don't hold up:

- Putting the descriptor back into blocking mode needs `process.stdout._handle.setBlocking()`, which is private, exists
  only on the main thread, and makes Node's own asynchronous writes through `process.stdout` block the event loop.
- Constructing the Workers with `stdout: true, stderr: true` keeps the pool from triggering it (above), but output a
  Worker writes through `process.stdout`, `console.log` included, then needs forwarding by hand, and anything else in
  the process that opens `process.stdout` still triggers it.

```diff
--- a/src/lib/libnoderawfs.js
+++ b/src/lib/libnoderawfs.js
@@ -261,7 +261,18 @@
       }
       var seeking = typeof position !== 'undefined';
       if (!seeking && stream.seekable) position = stream.position;
-      var bytesWritten = fs.writeSync(stream.nfd, buffer, offset, length, position);
+      var bytesWritten;
+      while (true) {
+        try {
+          bytesWritten = fs.writeSync(stream.nfd, buffer, offset, length, position);
+          break;
+        } catch (e) {
+          // Node can make stdout and stderr non-blocking behind the program's
+          // back; only a stream the program made non-blocking may fail.
+          if (e.code !== 'EAGAIN' || (stream.flags & {{{ cDefs.O_NONBLOCK }}})) throw e;
+          nodeWaitForWritable();
+        }
+      }
       // update position marker when non-seeking
       if (!seeking) stream.position += bytesWritten;
       return bytesWritten;
--- /dev/null
+++ b/src/node_shell_write.js
@@ -0,0 +1,37 @@
+/**
+ * @license
+ * Copyright 2026 The Emscripten Authors
+ * SPDX-License-Identifier: MIT
+ */
+
+// Node makes a pipe or socket on stdout or stderr non-blocking as soon as it
+// opens `process.stdout` or `process.stderr` on it, which it does for every
+// Worker it constructs, to forward the Worker's stdio.  From then on a
+// synchronous write there writes only part of its data, or fails with EAGAIN,
+// whenever the reader has fallen behind, though the program never asked for
+// non-blocking output.  Node has no synchronous way to wait until a descriptor
+// is writable, so these wait a moment and try again.
+
+var nodeWaitCell;
+
+function nodeWaitForWritable() {
+  nodeWaitCell ??= new Int32Array(new SharedArrayBuffer(4));
+  Atomics.wait(nodeWaitCell, 0, 0, 1);
+}
+
+// Writes all of `str` to `fd`, as a blocking write would.
+function nodeWriteAllSync(fd, str) {
+  var fs = require('node:fs');
+  var length = Buffer.byteLength(str);
+  var written = 0;
+  var buf;
+  while (written < length) {
+    try {
+      // Only resuming part-way through needs the string's bytes.
+      written += written ? fs.writeSync(fd, buf ??= Buffer.from(str), written) : fs.writeSync(fd, str);
+    } catch (e) {
+      if (e.code !== 'EAGAIN') throw e;
+      nodeWaitForWritable();
+    }
+  }
+}
--- a/src/runtime_debug.js
+++ b/src/runtime_debug.js
@@ -15,7 +15,6 @@
   // See https://github.com/emscripten-core/emscripten/issues/14804
   if (ENVIRONMENT_IS_NODE) {
     // TODO(sbc): Unify with err/out implementation in shell.sh.
-    var fs = require('node:fs');
     var utils = require('node:util');
     function stringify(a) {
       switch (typeof a) {
@@ -24,7 +23,7 @@
       }
       return a;
     }
-    fs.writeSync(2, args.map(stringify).join(' ') + '\n');
+    nodeWriteAllSync(2, args.map(stringify).join(' ') + '\n');
   } else
 #endif
   // TODO(sbc): Make this configurable somehow.  Its not always convenient for
--- a/src/shell.js
+++ b/src/shell.js
@@ -329,6 +329,10 @@
 #endif // ASSERTIONS
 }

+#if ENVIRONMENT_MAY_BE_NODE && (PTHREADS || WASM_WORKERS || NODERAWFS)
+#include "node_shell_write.js"
+#endif
+
 #if ENVIRONMENT_MAY_BE_NODE && (PTHREADS || WASM_WORKERS)
 // Set up the out() and err() hooks, which are how we can print to stdout or
 // stderr, respectively.
@@ -341,8 +345,8 @@
 if (ENVIRONMENT_IS_NODE) {
   var utils = require('node:util');
   var stringify = (a) => typeof a === 'object' ? utils.inspect(a) : a;
-  defaultPrint = (...args) => fs.writeSync(1, args.map(stringify).join(' ') + '\n');
-  defaultPrintErr = (...args) => fs.writeSync(2, args.map(stringify).join(' ') + '\n');
+  defaultPrint = (...args) => nodeWriteAllSync(1, args.map(stringify).join(' ') + '\n');
+  defaultPrintErr = (...args) => nodeWriteAllSync(2, args.map(stringify).join(' ') + '\n');
 }
 {{{ makeModuleReceiveWithVar('out', 'print',    'defaultPrint') }}}
 {{{ makeModuleReceiveWithVar('err', 'printErr', 'defaultPrintErr') }}}
--- a/src/shell_minimal.js
+++ b/src/shell_minimal.js
@@ -94,6 +94,10 @@
 // and build with --closure 1 to get Closure optimize out all the uses
 // altogether.

+#if ENVIRONMENT_MAY_BE_NODE && (PTHREADS || WASM_WORKERS || NODERAWFS)
+#include "node_shell_write.js"
+#endif
+
 #if ENVIRONMENT_MAY_BE_NODE && PTHREADS
 // Set up the out() and err() hooks, which are how we can print to stdout or
 // stderr, respectively.
@@ -105,8 +109,8 @@
 var defaultPrintErr = console.error.bind(console);
 if (ENVIRONMENT_IS_NODE) {
   var fs = require('node:fs');
-  defaultPrint = (...args) => fs.writeSync(1, args.join(' ') + '\n');
-  defaultPrintErr = (...args) => fs.writeSync(2, args.join(' ') + '\n');
+  defaultPrint = (...args) => nodeWriteAllSync(1, args.join(' ') + '\n');
+  defaultPrintErr = (...args) => nodeWriteAllSync(2, args.join(' ') + '\n');
 }
 var out = defaultPrint;
 var err = defaultPrintErr;
```

`node_shell_write.js` is included only in Node builds with threads or NODERAWFS, the ones that write with
`fs.writeSync()`, as the shells already include `node_shell_read.js`. Function declarations make both helpers available
to `dbg()` and to the libraries wherever the include lands.

A test, `other.test_node_stdio_slow_reader`, builds a program with a one-Worker pool and reads its output only after a
second, in seven variants: from the main thread and from a pthread, to stderr, on WasmFS (from the main thread and from
a pthread), on NODERAWFS, and with `MINIMAL_RUNTIME`. Each fails without the fix and passes with it.

---

## Evidence

- **How the fix was tested.**
  - The test case and variants of it, built with ibus-web's toolchain (6.0.9 with patches 0001–0019, none of which touch
    these lines) and run with the reader sleeping a second first. Without 0020: the JavaScript file system and WasmFS,
    from the main thread and from a pthread, stop after 65536 or 49200 bytes with `EAGAIN` (a pthread on WasmFS throws
    in its Worker); `MINIMAL_RUNTIME` stops after 65536 bytes with `TypeError: e.match is not a function`, from a
    `run()` that expects the exception to be a string; NODERAWFS stops after 49200 bytes with status 0. With 0020: every
    byte and status 0 in each case, at `-O0`, `-O2` and `-O2 --closure=1`, and with `-sEXPORT_ES6` under NODERAWFS. A
    line of 300,001 two-byte characters, which a short write splits mid-character, arrives intact (its SHA-256 matches).
    A NODERAWFS program that sets `O_NONBLOCK` on stdout itself still gets `EAGAIN` after 65536 bytes. A
    `-sRUNTIME_DEBUG` build still prints its `dbg()` lines.
  - ibus-web's `checks.emscripten-fixes` (`modules/emscripten/checks/fixes/stdio-burst.c` and `fixes.test.ts`) writes
    1.25 MiB to stdout and to stderr, from the main thread and from a pthread, on the JavaScript file system, WasmFS and
    NODERAWFS, and reads neither stream for the first half second: all twelve cases fail without 0020 and pass with it.
  - The suite-format test on Emscripten's runner, on 6.0.9 with ibus-web's stack (nixpkgs' LLVM 22.1.8, Binaryen 132,
    Node 24.21.0): `FAILED (failures=7)` with 0001–0019, `OK` for all 7 with 0020 added.
  - With 0020, ibus-web's test programs under Node pass without the harness's own workaround, a preload that made the
    pipes blocking again; the m17n engines' 198 tests, whose listing first showed the bug, are among them.
- **FAQ.** Nothing in it covers output under Node with threads. Run at `-O0` and `-O2`, with the same result.
- **bug_reports.rst.** The source, `emcc -v`, the symptoms, a tested fix and a test are included.
- **Duplicate search.** `gh api search/issues` on the repository, issues and PRs, for "EAGAIN", "writeSync",
  "`"non-blocking" stdout`", "nonblocking stdout", "setBlocking", "`"Resource temporarily unavailable"`", "stdout
  truncated node", "output truncated pipe", "`"partial write"`", "`"short write"`", "stdout pipe pthread", "printf lost
  node" and "fd_write EAGAIN" turned up nothing on this. Nearest:
  - #17962 (merged 2022): the same partial writes and `EAGAIN` in `acorn-optimizer.js`'s own output, fixed there alone
    (#17960 was its symptom on Binaryen's CI).
  - #14804 and #14805: why `out()` and `err()` use `fs.writeSync()` under Node with threads.
  - #21919: NODERAWFS's stdout going through `fs.writeSync(1, …)`, by design.
  - #22258 and #22261: `doWritev` stopping at a partial write, which NODERAWFS's short counts rely on.
  - #13214, #22032, #26708 and #27831: `EAGAIN` from Emscripten's own pipes (PIPEFS, WasmFS), not the host's.
  - #21313: an `EAGAIN` reading stdin under Node, not output.

  A search of Node's own issues was cut short by the API's rate limit.

- **Tip-of-tree.** Checked read-only through the GitHub API on 2026-10-09: on `main` (ac0c905), `shell.js` L344–L345,
  `shell_minimal.js` L108–L109, `runtime_debug.js` L27 and `libnoderawfs.js` L264 make the same single `fs.writeSync()`
  calls. 6.0.12 is the latest release. `main` wasn't rebuilt.
- ibus-web carries this fix as `modules/emscripten/patches/0020-node-stdio-eagain.patch`, with 6.0.9's `==` and `!=`.
