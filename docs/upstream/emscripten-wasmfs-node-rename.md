# WasmFS Node backend: a renamed file keeps its old host path

**Draft: new issue.** No existing issue covers it.

## Issue title

WasmFS Node backend: after rename(), the file still refers to its old host path (reads/writes go to the wrong file)

## Issue body

---

After `rename("/host/a", "/host/b")` on a `wasmfs_create_node_backend()`
directory, the host file is renamed, but WasmFS's `File` object for it still
holds the host path `…/a`. Every later open of `/host/b` opens the host's `…/a`.
If nothing is at `…/a`, the open fails on the host (which then surfaces
confusingly, see below). If something new has been created at `…/a`, reads and
writes through `/host/b` silently go to that other file.

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

**Test case** (`node_rename.c`; `argv[1]` is an existing host directory):

```c
#include <emscripten/wasmfs.h>
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>

static void put(const char *path, const char *text, size_t len) {
  int fd = open(path, O_CREAT | O_WRONLY | O_TRUNC, 0644);
  write(fd, text, len);
  close(fd);
}

int main(int argc, char **argv) {
  /* argv[1]: an existing host directory, mounted at /host. */
  wasmfs_create_directory("/host", 0777, wasmfs_create_node_backend(argv[1]));

  put("/host/a", "contents of a\n", 14);
  printf("rename(\"/host/a\", \"/host/b\") = %d\n", rename("/host/a", "/host/b"));
  /* Reuse the old name for an unrelated file. */
  put("/host/a", "a new file a\n", 13);

  char buf[32] = {0};
  int fd = open("/host/b", O_RDONLY);
  ssize_t n = read(fd, buf, sizeof buf - 1);
  close(fd);
  printf("read(\"/host/b\") = %zd: %s", n, buf);
  return 0;
}
```

**Failing command line in full** (the same at `-O2`):

```
$ emcc -O0 -sWASMFS node_rename.c -o node_rename.js && mkdir host && node node_rename.js "$PWD/host" && head host/*
rename("/host/a", "/host/b") = 0
read("/host/b") = 13: a new file a
==> host/a <==
a new file a

==> host/b <==
contents of a
```

Expected `read("/host/b") = 14: contents of a`.

Renaming a directory leaves its already-looked-up children pointing at the old
directory too (`node_rename_dir.c`):

```c
#include <emscripten/wasmfs.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

int main(int argc, char **argv) {
  wasmfs_create_directory("/host", 0777, wasmfs_create_node_backend(argv[1]));
  mkdir("/host/d", 0777);
  int fd = open("/host/d/f", O_CREAT | O_WRONLY | O_TRUNC, 0644);
  write(fd, "in f\n", 5);
  close(fd);
  printf("rename dir = %d\n", rename("/host/d", "/host/e"));
  char buf[16] = {0};
  errno = 0;
  fd = open("/host/e/f", O_RDONLY);
  ssize_t n = read(fd, buf, sizeof buf - 1);
  printf("read(\"/host/e/f\") = %zd (%s) %s", n, n < 0 ? strerror(errno) : "ok", buf);
  if (n <= 0) printf("\n");
  return 0;
}
```

```
$ emcc -O0 -sWASMFS node_rename_dir.c -o node_rename_dir.js && mkdir host && node node_rename_dir.js "$PWD/host"
rename dir = 0
read("/host/e/f") = -1 (Bad file descriptor) 
```

<details>
<summary>Full compile and link output with <code>-v</code> appended (cache and scratch paths shortened)</summary>

```
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/clang -target wasm32-unknown-emscripten -fignore-exceptions -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr --sysroot=$EM_CACHE/sysroot -resource-dir=/nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter$EM_CACHE/sysroot/include -iwithsysroot/include/c++/v1 -Xclang -iwithsysroot/include/fakesdl -Xclang -iwithsysroot/include/compat -v -O0 -c node_rename.c -o /tmp/emscripten_temp_b4blae6e/node_rename.o
clang version 22.1.8
Target: wasm32-unknown-emscripten
Thread model: posix
InstalledDir: /nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin
 (in-process)
 "/nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin/clang-22" -cc1 -triple wasm32-unknown-emscripten -O0 -emit-obj -disable-free -clear-ast-before-backend -disable-llvm-verifier -discard-value-names -main-file-name node_rename.c -mrelocation-model static -mframe-pointer=none -ffp-contract=on -fno-rounding-math -mconstructor-aliases -target-cpu generic -fvisibility=hidden -debugger-tuning=gdb -fdebug-compilation-dir=. -v -fcoverage-compilation-dir=. -resource-dir /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter $EM_CACHE/sysroot/include -iwithsysroot /include/c++/v1 -isysroot $EM_CACHE/sysroot -internal-isystem /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/include -internal-isystem $EM_CACHE/sysroot/include/wasm32-emscripten -internal-isystem $EM_CACHE/sysroot/include -ferror-limit 19 -fgnuc-version=4.2.1 -fskip-odr-check-in-gmf -fignore-exceptions -iwithsysroot/include/fakesdl -iwithsysroot/include/compat -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr -o /tmp/emscripten_temp_b4blae6e/node_rename.o -x c node_rename.c
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
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/wasm-ld -o node_rename.wasm /tmp/tmpdjwwqga2libemscripten_js_symbols.so -Bstatic --strip-debug --export=emscripten_stack_get_end --export=emscripten_stack_get_free --export=emscripten_stack_get_base --export=emscripten_stack_get_current --export=emscripten_stack_init --export=wasmfs_flush --export=_emscripten_stack_alloc --export=__wasm_call_ctors --export=_emscripten_stack_restore --export-if-defined=__start_em_asm --export-if-defined=__stop_em_asm --export-if-defined=__start_em_lib_deps --export-if-defined=__stop_em_lib_deps --export-if-defined=__start_em_js --export-if-defined=__stop_em_js --export-if-defined=main --export-if-defined=__main_argc_argv --export-if-defined=fflush --export-table -z stack-size=65536 --no-growable-memory --initial-heap=16777216 --no-entry --stack-first --table-base=1 /tmp/emscripten_temp_b4blae6e/node_rename.o -L$EM_CACHE/sysroot/lib/wasm32-emscripten -L/nix/store/03iyrnrsxnbc64y6r62irmlbnbap5ya2-emscripten-6.0.9/share/emscripten/src/lib -lGL-getprocaddr -lal -lhtml5 -lstubs-debug -lnoexit -lc-debug -ldlmalloc-debug -lclang_rt.builtins -lc++-debug-noexcept -lc++abi-debug-noexcept -lsockets -lwasmfs_no_fs -lwasmfs-debug -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/llvm-objcopy node_rename.wasm node_rename.wasm '--remove-section=llvm.func_attr.annotate.*' --remove-section=producers --remove-section=name '--remove-section=.debug*'
```

</details>

**Where:**
- `NodeDirectory::insertMove` renames on the host but never updates the moved
  file's `state.path`
  ([node_backend.cpp#L247-L260](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/backends/node_backend.cpp#L247-L260)).
- `NodeState::open` then opens that stale path
  ([node_backend.cpp#L39-L88](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/backends/node_backend.cpp#L39-L88)).
- Node directories don't maintain file identity, so the moved `File` stays in
  the new parent's dcache, path and all.
- A directory's cached children each carry a full host path built from the
  directory's old path.

**Suggested fix (files):** update the path after a successful rename.

```diff
--- a/system/lib/wasmfs/backends/node_backend.cpp
+++ b/system/lib/wasmfs/backends/node_backend.cpp
@@ -256,7 +256,15 @@
     }

     auto childPath = getChildPath(name);
-    return -_wasmfs_node_rename(fromPath.c_str(), childPath.c_str());
+    if (auto err = _wasmfs_node_rename(fromPath.c_str(), childPath.c_str())) {
+      return -err;
+    }
+    if (file->is<DataFile>()) {
+      std::static_pointer_cast<NodeFile>(file)->state.path = childPath;
+    } else {
+      std::static_pointer_cast<NodeDirectory>(file)->state.path = childPath;
+    }
+    return 0;
   }

   ssize_t getNumEntries() override {
```

With this applied to 6.0.9, the file case prints:

```
rename("/host/a", "/host/b") = 0
read("/host/b") = 14: contents of a
```

It does **not** fix the directory case, whose cached children keep their old
paths. A complete fix would stop storing full host paths: build each file's
host path from its parent's path and its name when it's needed. Alternatively,
walk the moved directory's dcache and rewrite the cached descendants.

**Related symptom:** when the stale path doesn't exist, the failed host `open`
isn't reported as a failure. `open()` returns a descriptor, `read()` then fails
with `EBADF`, and `close()` trips `assert(ret >= 0)` in `__wasi_fd_close`. That
is a separate bug in how the backend handles host errors, reported in #NNNN.

---

## Notes for the user

- **Fill in #NNNN.** It is the issue number of
  `emscripten-wasmfs-node-open-close-errors.md` once that's posted. Or drop the
  paragraph if you post this one first.
- **FAQ.** Nothing in the FAQ covers it. Run at `-O0` and `-O2`, with the same
  result.
- **bug_reports.rst.** The source, `emcc -v`, the symptoms and a tested fix
  (files only) are included. Bitcode is left out because the fault is in
  `libwasmfs`. The directory case has only a sketched fix.
- **Duplicate search.** "wasmfs node backend rename", "wasmfs rename node",
  "wasmfs rename", "insertMove", "wasmfs node backend" and "node_backend.cpp",
  plus a scan of all open "wasmfs" issues, turned up:
  - #26598 (merged), which fixed the sign of `insertMove`'s return value but
    not the path.
  - #24162 and #27684/#27685, which are about OPFS and lock-order rename bugs.
  - #15943 (closed, rename cycles).
  None is this bug.
- **Why it matters to us.** GLib's `g_file_set_contents()` writes a temporary
  file and renames it over the target. Under Node with host temp files,
  `bookmarkfile`, `keyfile`, `mappedfile`, `sandbox` and
  `async-splice-output-stream` hit it (through the `fd_close` assertion), and
  so did the GLib smoke test. The tests keep `TMPDIR` in memory to avoid it.
- **Caveat maintainers may raise.** #19417 notes that WasmFS assumes it has
  complete control over the file system. The reproduction changes files only
  through WasmFS, so it doesn't depend on outside changes.
- **Not verified on tip-of-tree or emsdk's latest release.** The build is
  nixpkgs' 6.0.9 with LLVM 22.1.8.
