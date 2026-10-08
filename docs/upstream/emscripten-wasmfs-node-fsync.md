# WasmFS Node backend: `fsync()` traps (`NodeFile::flush` is unreachable)

**Posted: don't post again.** Filed as
[#27822](https://github.com/emscripten-core/emscripten/issues/27822)
(2026-10-01), with the fix and a test as PR
[#27844](https://github.com/emscripten-core/emscripten/pull/27844) ("[WasmFS]
Implement fsync for the Node backend", open, no review yet).

Checked against `main` 5977ecc (2026-10-02): `NodeFile::flush` is still
`WASMFS_UNREACHABLE`, and 0009 applies there alone exactly.

**Draft: new issue.** No existing issue covers it.

## Issue title

WasmFS Node backend: fsync() aborts with "TODO: implement NodeFile::flush"

## Issue body

---

`fsync()` (or `fdatasync()`) on a file in a `wasmfs_create_node_backend()`
directory kills the program. Without assertions it is a bare
`RuntimeError: unreachable`. Writing a file and `fsync`ing it before a `rename`
is the usual way to replace a file safely, so ordinary programs hit this. GLib's
`g_file_set_contents()` does it whenever it replaces a non-empty file.

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

**Test case** (`node_fsync.c`; `argv[1]` is an existing host directory):

```c
#include <emscripten/wasmfs.h>
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>

int main(int argc, char **argv) {
  /* argv[1]: an existing host directory, mounted at /host. */
  wasmfs_create_directory("/host", 0777, wasmfs_create_node_backend(argv[1]));

  int fd = open("/host/file", O_CREAT | O_WRONLY | O_TRUNC, 0644);
  write(fd, "data\n", 5);
  printf("before fsync\n");
  fflush(stdout);
  int r = fsync(fd);
  printf("fsync = %d\n", r);
  close(fd);
  return 0;
}
```

**Failing command line in full:**

```
$ emcc -O0 -sWASMFS node_fsync.c -o node_fsync.js && mkdir host && node node_fsync.js "$PWD/host"
before fsync
TODO: implement NodeFile::flush
UNREACHABLE executed
at /emsdk/emscripten/system/lib/wasmfs/backends/node_backend.cpp:154
wasm://wasm/0005e96a:1


RuntimeError: unreachable
    at wasm://wasm/0005e96a:wasm-function[245]:0x9bea
    at wasm://wasm/0005e96a:wasm-function[203]:0x8264
    at wasm://wasm/0005e96a:wasm-function[370]:0x10d83
    at wasm://wasm/0005e96a:wasm-function[369]:0x10c01
    at wasm://wasm/0005e96a:wasm-function[38]:0xb69
    at wasm://wasm/0005e96a:wasm-function[34]:0x9ed
    at node_fsync.js:615:12
    at callMain (node_fsync.js:2051:15)
    at run (node_fsync.js:2097:22)
    at node_fsync.js:2137:25

Node.js v24.20.0
[exit status 1]
```

At `-O2`:

```
$ emcc -O2 -sWASMFS node_fsync.c -o node_fsync.js && mkdir host && node node_fsync.js "$PWD/host" > run.log 2>&1; sed -n "/^before/p; /^RuntimeError/p" run.log
before fsync
RuntimeError: unreachable
```

<details>
<summary>Full compile and link output with <code>-v</code> appended (cache and scratch paths shortened)</summary>

```
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/clang -target wasm32-unknown-emscripten -fignore-exceptions -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr --sysroot=$EM_CACHE/sysroot -resource-dir=/nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter$EM_CACHE/sysroot/include -iwithsysroot/include/c++/v1 -Xclang -iwithsysroot/include/fakesdl -Xclang -iwithsysroot/include/compat -v -O0 -c node_fsync.c -o /tmp/emscripten_temp_qpf8m5jj/node_fsync.o
clang version 22.1.8
Target: wasm32-unknown-emscripten
Thread model: posix
InstalledDir: /nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin
 (in-process)
 "/nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin/clang-22" -cc1 -triple wasm32-unknown-emscripten -O0 -emit-obj -disable-free -clear-ast-before-backend -disable-llvm-verifier -discard-value-names -main-file-name node_fsync.c -mrelocation-model static -mframe-pointer=none -ffp-contract=on -fno-rounding-math -mconstructor-aliases -target-cpu generic -fvisibility=hidden -debugger-tuning=gdb -fdebug-compilation-dir=. -v -fcoverage-compilation-dir=. -resource-dir /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter $EM_CACHE/sysroot/include -iwithsysroot /include/c++/v1 -isysroot $EM_CACHE/sysroot -internal-isystem /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/include -internal-isystem $EM_CACHE/sysroot/include/wasm32-emscripten -internal-isystem $EM_CACHE/sysroot/include -ferror-limit 19 -fgnuc-version=4.2.1 -fskip-odr-check-in-gmf -fignore-exceptions -iwithsysroot/include/fakesdl -iwithsysroot/include/compat -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr -o /tmp/emscripten_temp_qpf8m5jj/node_fsync.o -x c node_fsync.c
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
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/wasm-ld -o node_fsync.wasm /tmp/tmp8qwr8ue6libemscripten_js_symbols.so -Bstatic --strip-debug --export=emscripten_stack_get_end --export=emscripten_stack_get_free --export=emscripten_stack_get_base --export=emscripten_stack_get_current --export=emscripten_stack_init --export=wasmfs_flush --export=_emscripten_stack_alloc --export=__wasm_call_ctors --export=_emscripten_stack_restore --export-if-defined=__start_em_asm --export-if-defined=__stop_em_asm --export-if-defined=__start_em_lib_deps --export-if-defined=__stop_em_lib_deps --export-if-defined=__start_em_js --export-if-defined=__stop_em_js --export-if-defined=main --export-if-defined=__main_argc_argv --export-if-defined=fflush --export-table -z stack-size=65536 --no-growable-memory --initial-heap=16777216 --no-entry --stack-first --table-base=1 /tmp/emscripten_temp_qpf8m5jj/node_fsync.o -L$EM_CACHE/sysroot/lib/wasm32-emscripten -L/nix/store/03iyrnrsxnbc64y6r62irmlbnbap5ya2-emscripten-6.0.9/share/emscripten/src/lib -lGL-getprocaddr -lal -lhtml5 -lstubs-debug -lnoexit -lc-debug -ldlmalloc-debug -lclang_rt.builtins -lc++-debug-noexcept -lc++abi-debug-noexcept -lsockets -lwasmfs_no_fs -lwasmfs-debug -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/llvm-objcopy node_fsync.wasm node_fsync.wasm '--remove-section=llvm.func_attr.annotate.*' --remove-section=producers --remove-section=name '--remove-section=.debug*'
```

</details>

**Where:** `NodeFile::flush` is `WASMFS_UNREACHABLE("TODO: implement
NodeFile::flush")`
([node_backend.cpp#L153-L155](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/backends/node_backend.cpp#L153-L155)).
`__wasi_fd_sync` calls it for every data file
([syscalls.cpp#L311-L328](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/syscalls.cpp#L311-L328)).

**Suggested fix:** forward to `fs.fsyncSync` on the open host descriptor.

```diff
--- a/src/lib/libsigs.js
+++ b/src/lib/libsigs.js
@@ -421,6 +421,7 @@
   _wasmfs_jsimpl_write__sig: 'ippppj',
   _wasmfs_node_close__sig: 'ii',
   _wasmfs_node_fstat_size__sig: 'iip',
+  _wasmfs_node_fsync__sig: 'ii',
   _wasmfs_node_ftruncate__sig: 'iij',
   _wasmfs_node_get_mode__sig: 'ipp',
   _wasmfs_node_insert_directory__sig: 'ipi',
--- a/src/lib/libwasmfs_node.js
+++ b/src/lib/libwasmfs_node.js
@@ -190,6 +190,14 @@
     });
   },

+  _wasmfs_node_fsync__deps: ['$wasmfsTry'],
+  _wasmfs_node_fsync: (fd) => {
+    return wasmfsTry(() => {
+      fs.fsyncSync(fd);
+      // implicitly return 0
+    });
+  },
+
   _wasmfs_node_close__deps: ['$wasmfsTry'],
   _wasmfs_node_close: (fd) => {
     return wasmfsTry(() => {
--- a/system/lib/wasmfs/backends/node_backend.cpp
+++ b/system/lib/wasmfs/backends/node_backend.cpp
@@ -150,9 +150,7 @@
     return nwritten;
   }

-  int flush() override {
-    WASMFS_UNREACHABLE("TODO: implement NodeFile::flush");
-  }
+  int flush() override { return -_wasmfs_node_fsync(state.getFD()); }
 };

 class NodeSymlink : public Symlink {
--- a/system/lib/wasmfs/backends/node_backend.h
+++ b/system/lib/wasmfs/backends/node_backend.h
@@ -42,6 +42,9 @@
 // Close the underlying file descriptor.
 [[nodiscard]] int _wasmfs_node_close(int fd);

+// Flush the underlying file descriptor and return 0 or an error code.
+[[nodiscard]] int _wasmfs_node_fsync(int fd);
+
 // Read up to `size` bytes into `buf` from position `pos` in the file, writing
 // the number of bytes read to `nread`. Return 0 on success or an error code.
 int _wasmfs_node_read(
```

With this applied to 6.0.9 (and `cat host/file` added after the run):

```
before fsync
fsync = 0
data
```

---

## Evidence

- **How the fix was tested.** The "with this applied" run used a 6.0.9 tree
  with all of this set's candidate fixes applied at once (this one, the
  `rename` and `open`/`close` fixes for the Node backend, and the others). The
  program here doesn't touch the code the others change.
- **FAQ.** Nothing in the FAQ covers this. A `WASMFS_UNREACHABLE` with a TODO
  is plainly unimplemented, not intended. Run at `-O0` and `-O2`, which crash
  the same way.
- **`libsigs.js`.** The new import needs its signature there, which
  `tools/maint/gen_sig_info.py` would add; without it `other.test_gen_sig_info`
  fails and wasm64 builds break. The hunk includes it, and the test passes.
- **bug_reports.rst.** The source, `emcc -v`, the symptoms and a tested fix are
  included. Bitcode is left out because the fault is in `libwasmfs`. The fix is
  small and could go straight to a PR, with a `test/` case that `fsync`s a
  NODEFS file under WasmFS.
- **Duplicate search.** "WasmFS fsync node", "NodeFile::flush", "implement
  NodeFile::flush", "fsync unreachable", "UNREACHABLE wasmfs", "wasmfs fsync"
  and "fsync", plus a scan of all open "wasmfs" issues, turned up:
  - #19903 (open PR, "WasmFS JS API: Implement syncfs"), which mentions
    `NodeFile::flush` but doesn't implement it.
  - #18491 ("[WasmFS] Flush not reaching backend", closed), which is about
    whether flushes reach backends at all.
  - #27806 (merged 2026-09-30), which fixes `fdatasync`'s error sign and
    doesn't touch the Node backend.
    None reports this trap.
- **Why it matters to us.** Under WasmFS, `glib-compile-schemas` run twice
  into one directory traps here. With the fix it runs twice cleanly; the
  GLib tools still stay on NODERAWFS for another reason (WasmFS's stdout
  turns a NUL byte into a line break).
- **Tip-of-tree.** Checked read-only through the GitHub API on 2026-09-30:
  `node_backend.cpp`, `node_backend.h` and `libwasmfs_node.js` are unchanged
  between 6.0.9 and `main` (2151200, 139 commits later). `syscalls.cpp` changed
  only in `fdatasync`'s error sign (#27806) and `utimensat`'s timestamp
  rounding; the cited code is unchanged, a few lines further down. The latest
  release, 6.0.10 (tagged 2026-09-18), matches. The conclusion comes from the
  diff; `main` wasn't rebuilt. Our build is nixpkgs' 6.0.9 with LLVM 22.1.8.
- ibus-web carries this fix as `modules/emscripten/patches/0009-wasmfs-node-fsync.patch`.
