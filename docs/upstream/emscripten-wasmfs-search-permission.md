# WasmFS: directory search (execute) permission is never checked

**Draft: new issue.** No existing issue covers it. The closest is #18033 (a file
can be created in a read-only directory; see the companion draft
`emscripten-wasmfs-create-permission.md`). There a maintainer noted "the
permissions checking is a bit spotty overall."

## Issue title

WasmFS: chdir() and path lookup ignore directory search (execute) permission

## Issue body

---

WasmFS never checks search (execute) permission on directories. `chdir()` into
a directory without `x` succeeds, and so does any lookup through one (`stat`,
`open`, …). The JS file system returns `EACCES` for all of these. So does
WasmFS's own `access(dir, X_OK)`, which disagrees with what `chdir()` then does.

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

**Test case** (`search_perm.c`):

```c
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static void report(const char *what, int r) {
  printf("%-40s %s\n", what, r < 0 ? strerror(errno) : "succeeded");
}

int main(void) {
  printf("uid %d\n", (int)getuid());
  mkdir("/d", 0777);
  close(open("/d/f", O_CREAT | O_WRONLY, 0666));
  /* Readable and writable, but not searchable. */
  chmod("/d", 0666);

  struct stat st;
  errno = 0;
  report("stat(\"/d/f\")", stat("/d/f", &st));
  errno = 0;
  int fd = open("/d/f", O_RDONLY);
  report("open(\"/d/f\", O_RDONLY)", fd);
  if (fd >= 0)
    close(fd);
  errno = 0;
  report("access(\"/d\", X_OK)", access("/d", X_OK));
  errno = 0;
  report("chdir(\"/d\")", chdir("/d"));
  return 0;
}
```

**Failing command line in full** (the same at `-O2`):

```
$ emcc -O0 -sWASMFS search_perm.c -o search_perm.js && node search_perm.js
uid 0
stat("/d/f")                             succeeded
open("/d/f", O_RDONLY)                   succeeded
access("/d", X_OK)                       Permission denied
chdir("/d")                              succeeded
```

Expected, as with the JS file system:

```
$ emcc -O0 search_perm.c -o search_perm.js && node search_perm.js
uid 0
stat("/d/f")                             Permission denied
open("/d/f", O_RDONLY)                   Permission denied
access("/d", X_OK)                       Permission denied
chdir("/d")                              Permission denied
```

Both file systems report uid 0. Linux would let root through, but Emscripten
enforces permission bits regardless (the JS FS here, and WasmFS's own `open`,
`mkdir`, `unlink` and `access`), ignoring ownership. So this is about WasmFS
being consistent with itself and with the JS FS.

<details>
<summary>Full compile and link output with <code>-v</code> appended (cache and scratch paths shortened)</summary>

```
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/clang -target wasm32-unknown-emscripten -fignore-exceptions -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr --sysroot=$EM_CACHE/sysroot -resource-dir=/nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter$EM_CACHE/sysroot/include -iwithsysroot/include/c++/v1 -Xclang -iwithsysroot/include/fakesdl -Xclang -iwithsysroot/include/compat -v -O0 -c search_perm.c -o /tmp/emscripten_temp_vvo31o3a/search_perm.o
clang version 22.1.8
Target: wasm32-unknown-emscripten
Thread model: posix
InstalledDir: /nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin
 (in-process)
 "/nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin/clang-22" -cc1 -triple wasm32-unknown-emscripten -O0 -emit-obj -disable-free -clear-ast-before-backend -disable-llvm-verifier -discard-value-names -main-file-name search_perm.c -mrelocation-model static -mframe-pointer=none -ffp-contract=on -fno-rounding-math -mconstructor-aliases -target-cpu generic -fvisibility=hidden -debugger-tuning=gdb -fdebug-compilation-dir=. -v -fcoverage-compilation-dir=. -resource-dir /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter $EM_CACHE/sysroot/include -iwithsysroot /include/c++/v1 -isysroot $EM_CACHE/sysroot -internal-isystem /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/include -internal-isystem $EM_CACHE/sysroot/include/wasm32-emscripten -internal-isystem $EM_CACHE/sysroot/include -ferror-limit 19 -fgnuc-version=4.2.1 -fskip-odr-check-in-gmf -fignore-exceptions -iwithsysroot/include/fakesdl -iwithsysroot/include/compat -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr -o /tmp/emscripten_temp_vvo31o3a/search_perm.o -x c search_perm.c
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
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/wasm-ld -o search_perm.wasm /tmp/tmpnsyiy5q0libemscripten_js_symbols.so -Bstatic --strip-debug --export=emscripten_stack_get_end --export=emscripten_stack_get_free --export=emscripten_stack_get_base --export=emscripten_stack_get_current --export=emscripten_stack_init --export=wasmfs_flush --export=_emscripten_stack_alloc --export=__wasm_call_ctors --export=_emscripten_stack_restore --export-if-defined=__start_em_asm --export-if-defined=__stop_em_asm --export-if-defined=__start_em_lib_deps --export-if-defined=__stop_em_lib_deps --export-if-defined=__start_em_js --export-if-defined=__stop_em_js --export-if-defined=main --export-if-defined=__main_argc_argv --export-if-defined=fflush --export-table -z stack-size=65536 --no-growable-memory --initial-heap=16777216 --no-entry --stack-first --table-base=1 /tmp/emscripten_temp_vvo31o3a/search_perm.o -L$EM_CACHE/sysroot/lib/wasm32-emscripten -L/nix/store/03iyrnrsxnbc64y6r62irmlbnbap5ya2-emscripten-6.0.9/share/emscripten/src/lib -lGL-getprocaddr -lal -lhtml5 -lstubs-debug -lnoexit -lc-debug -ldlmalloc-debug -lclang_rt.builtins -lc++-debug-noexcept -lc++abi-debug-noexcept -lsockets -lwasmfs_no_fs -lwasmfs-debug -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/llvm-objcopy search_perm.wasm search_perm.wasm '--remove-section=llvm.func_attr.annotate.*' --remove-section=producers --remove-section=name '--remove-section=.debug*'
```

</details>

**Where:**

- Path resolution has `// TODO: Check permissions on intermediate directories.`
  ([paths.cpp#L103](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/paths.cpp#L103)).
- `doChdir` checks only that the target is a directory
  ([syscalls.cpp#L731-L738](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/syscalls.cpp#L731-L738)).
- `access()` does check `X_OK`
  ([syscalls.cpp#L1266](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/syscalls.cpp#L1266)).

**Suggested fix:** check search permission on every directory a lookup passes
through, including the one the last component is looked up in, and on the
target of `chdir`/`fchdir`.

```diff
--- a/system/lib/wasmfs/paths.cpp
+++ b/system/lib/wasmfs/paths.cpp
@@ -93,6 +93,11 @@
       path.remove_prefix(1);
     }
 
+    // Looking up anything in a directory needs search permission on it.
+    if (!(curr->locked().getMode() & S_IXUGO)) {
+      return -EACCES;
+    }
+
     // If this is the leaf segment, return.
     size_t segment_end = path.find_first_of('/');
     if (segment_end == std::string_view::npos) {
@@ -100,7 +105,6 @@
     }
 
     // Try to descend into the child segment.
-    // TODO: Check permissions on intermediate directories.
     auto segment = path.substr(0, segment_end);
     auto child = getChild(curr, segment, FollowLinks, recursions);
     if (auto err = child.getError()) {
```

```diff
--- a/system/lib/wasmfs/syscalls.cpp
+++ b/system/lib/wasmfs/syscalls.cpp
@@ -733,6 +733,9 @@
   if (!dir) {
     return -ENOTDIR;
   }
+  if (!(dir->locked().getMode() & WASMFS_PERM_EXECUTE)) {
+    return -EACCES;
+  }
   wasmFS.setCWD(dir);
   return 0;
 }
```

With both applied to 6.0.9, the test case matches the JS FS:

```
uid 0
stat("/d/f")                             Permission denied
open("/d/f", O_RDONLY)                   Permission denied
access("/d", X_OK)                       Permission denied
chdir("/d")                              Permission denied
```

Several `test/wasmfs/*.c` programs (`chdir`, `mkdir`, `dup`, `getdents`, `seek`,
`open_append`, `fdatasync`, `chown`) and `test/unistd/access.c` give the same
results with and without the patch. We didn't run the full suite.

---

## Notes for the user

- **FAQ and docs.** The FAQ doesn't cover permissions. The File System API page
  says user and group permissions "are defined but ignored" and that "the
  caller is always treated as the owner", which is about which bits apply, not
  about skipping checks. The test clears every execute bit (mode `0666`), so
  it doesn't depend on ownership, which WasmFS ignores. Run at `-O0` and
  `-O2`, with the same result.
- **bug_reports.rst.** The source, `emcc -v`, the symptoms and a tested fix are
  included. Bitcode is left out because the fault is in `libwasmfs`. Small
  enough to send as a PR (with a `test/wasmfs` case) if preferred.
- **The patch is a sketch.** It runs one more lock-and-check per path component.
  We haven't checked whether internal callers (preloading, `wasmfs_create_*`,
  the JS API) resolve paths through directories created without `x`. The full
  test suite wasn't run; the programs listed in the body were.
- **Duplicate search.** "wasmfs permission", "wasmfs chdir permission", "wasmfs
  search permission directory", "WASMFS permissions", "permissions intermediate
  directories", "execute permission directory", "chdir EACCES", "chdir
  permission", "directory search permission", "permission traversal", "wasmfs
  access X_OK" and "EACCES", plus a scan of all open "wasmfs" issues, turned up
  only #18033 (create in a read-only directory), #14866 (JS FS read/write
  permission handling) and #26709 (`ftruncate` on a writable fd). None is this
  bug.
- **Why it matters to us.** GLib's `/fileutils/stdio-wrappers` (`chdir` into a
  `0666` directory) fails on WasmFS because of this.
  `/fileutils/set-contents-full/read-only-directory` (rewriting a file in a
  mode-0 directory) fails because of this together with the create-permission
  gap. Both hold in the browser too.
- **Tip-of-tree.** Checked read-only through the GitHub API on 2026-09-30:
  `paths.cpp` (with its TODO) is unchanged between 6.0.9 and `main` (2151200,
  139 commits later). `syscalls.cpp` changed only in `fdatasync`'s error sign
  (#27806) and `utimensat`'s timestamp rounding; the cited code is unchanged, a
  few lines further down. The latest release, 6.0.10 (tagged 2026-09-18),
  matches. The conclusion comes from the diff; `main` wasn't rebuilt. Our build
  is nixpkgs' 6.0.9 with LLVM 22.1.8.
- ibus-web carries this fix as `modules/emscripten/patches/0006-wasmfs-search-permission.patch`.
