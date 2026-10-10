# WasmFS: backend failures to create a symlink are reported as `EPERM`

**Still to post.** The create-`EIO` report went up as
[#27832](https://github.com/emscripten-core/emscripten/issues/27832) (2026-10-01) without this half, so post this as its
own issue citing #27832 (or as a comment there); the lookup report follows it. No issue or PR filed since covers it
(searches for "wasmfs symlink EPERM", "symlinkat EPERM", "insertSymlink", 2026-10-02).

Checked against `main` 5977ecc (2026-10-02): `__syscall_symlinkat` still turns any null from `insertSymlink()` into
`EPERM`, and 0017 applies on `main` after 0002–0015 (without 0004) with a 2-line offset; alone it doesn't, since it
builds on 0012. The draft has no suite-format test, so nothing was run for it on `main`.

**Draft: new issue (low priority).** No existing issue covers it. It is the symlink half of the report on `EIO` from
failed creates (`emscripten-wasmfs-node-create-eio.md`) and its fix builds on that one's; file the two together, or fold
this into it.

## Issue title

WasmFS: symlink() reports EPERM for any backend failure (e.g. EACCES from the Node backend)

## Issue body

---

When a backend fails to create a symlink, WasmFS returns `EPERM` whatever the cause. With the Node backend, a host
`EACCES` (or `EROFS`, `ENOSPC`, `EDQUOT`, …) comes back as "Operation not permitted", which for `symlink()` means "this
file system does not support symbolic links". A backend of one's own has no way to say anything else either.

**Version of emscripten/emsdk:**

```
emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 6.0.9-git
clang version 22.1.8
Target: wasm32-unknown-emscripten
Thread model: posix
InstalledDir: /nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin
```

This is the 6.0.9 release tag as packaged by nixpkgs. nixpkgs builds it against its own LLVM 22.1.8, so there is no
commit hash. Node.js v24.19.0, x86_64 Linux.

**Test case** (`node_symlink_eperm.c`; `argv[1]` is a host directory the non-root user can't write to):

```c
#include <emscripten/wasmfs.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
  /* argv[1]: a host directory this (non-root) user cannot write to, mounted
     at /host. */
  wasmfs_create_directory("/host", 0777, wasmfs_create_node_backend(argv[1]));

  errno = 0;
  int r = symlink("target", "/host/link");
  printf("symlink = %d (%s)\n", r, r < 0 ? strerror(errno) : "no error");
  return 0;
}
```

**Failing command line in full** (the same at `-O2`):

```
$ emcc -O0 -sWASMFS node_symlink_eperm.c -o node_symlink_eperm.js && mkdir -m 0555 host && id -u && node node_symlink_eperm.js "$PWD/host"
1000
symlink = -1 (Operation not permitted)
```

Expected `EACCES`, which is what the host returned.

<details>
<summary>Full compile and link output with <code>-v</code> appended (cache and scratch paths shortened)</summary>

```
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/clang -target wasm32-unknown-emscripten -fignore-exceptions -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr --sysroot=$EM_CACHE/sysroot -resource-dir=/nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter$EM_CACHE/sysroot/include -iwithsysroot/include/c++/v1 -Xclang -iwithsysroot/include/fakesdl -Xclang -iwithsysroot/include/compat -O0 -v -c node_symlink_eperm.c -o /tmp/emscripten_temp_c_XXXXXX/node_symlink_eperm.o
clang version 22.1.8
Target: wasm32-unknown-emscripten
Thread model: posix
InstalledDir: /nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin
 (in-process)
 "/nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin/clang-22" -cc1 -triple wasm32-unknown-emscripten -O0 -emit-obj -disable-free -clear-ast-before-backend -disable-llvm-verifier -discard-value-names -main-file-name node_symlink_eperm.c -mrelocation-model static -mframe-pointer=none -ffp-contract=on -fno-rounding-math -mconstructor-aliases -target-cpu generic -fvisibility=hidden -debugger-tuning=gdb -fdebug-compilation-dir=. -v -fcoverage-compilation-dir=. -resource-dir /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter $EM_CACHE/sysroot/include -iwithsysroot /include/c++/v1 -isysroot $EM_CACHE/sysroot -internal-isystem /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/include -internal-isystem $EM_CACHE/sysroot/include/wasm32-emscripten -internal-isystem $EM_CACHE/sysroot/include -ferror-limit 19 -fgnuc-version=4.2.1 -fskip-odr-check-in-gmf -fignore-exceptions -iwithsysroot/include/fakesdl -iwithsysroot/include/compat -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr -o /tmp/emscripten_temp_c_XXXXXX/node_symlink_eperm.o -x c node_symlink_eperm.c
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
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/wasm-ld -o node_symlink_eperm.wasm /tmp/tmpXXXXXXXXlibemscripten_js_symbols.so -Bstatic --strip-debug --export=emscripten_stack_get_end --export=emscripten_stack_get_free --export=emscripten_stack_get_base --export=emscripten_stack_get_current --export=emscripten_stack_init --export=wasmfs_flush --export=_emscripten_stack_alloc --export=__wasm_call_ctors --export=_emscripten_stack_restore --export-if-defined=__start_em_asm --export-if-defined=__stop_em_asm --export-if-defined=__start_em_lib_deps --export-if-defined=__stop_em_lib_deps --export-if-defined=__start_em_js --export-if-defined=__stop_em_js --export-if-defined=main --export-if-defined=__main_argc_argv --export-if-defined=fflush --export-table -z stack-size=65536 --no-growable-memory --initial-heap=16777216 --no-entry --stack-first --table-base=1 /tmp/emscripten_temp_c_XXXXXX/node_symlink_eperm.o -L$EM_CACHE/sysroot/lib/wasm32-emscripten -L/nix/store/03iyrnrsxnbc64y6r62irmlbnbap5ya2-emscripten-6.0.9/share/emscripten/src/lib -lGL-getprocaddr -lal -lhtml5 -lstubs-debug -lnoexit -lc-debug -ldlmalloc-debug -lclang_rt.builtins -lc++-debug-noexcept -lc++abi-debug-noexcept -lsockets -lwasmfs_no_fs -lwasmfs-debug -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/llvm-objcopy node_symlink_eperm.wasm node_symlink_eperm.wasm '--remove-section=llvm.func_attr.annotate.*' --remove-section=producers --remove-section=name '--remove-section=.debug*'
 /nix/store/lfaydgacdyngci7p60s8wwvgdm74fjkx-nodejs-24.19.0/bin/node /nix/store/03iyrnrsxnbc64y6r62irmlbnbap5ya2-emscripten-6.0.9/share/emscripten/tools/compiler.mjs -
```

</details>

**Where:**

- `__syscall_symlinkat` turns a null result from the backend's `insertSymlink` into `-EPERM`
  ([syscalls.cpp#L1107-L1109](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/syscalls.cpp#L1107-L1109)).
- `Directory::Handle::insertSymlink` returns null for an unlinked directory too, which is `ENOENT` on Linux
  ([file.cpp#L121-L131](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/file.cpp#L121-L131)).
- The Node backend has the host's errno in hand and drops it
  ([node_backend.cpp#L238-L244](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/backends/node_backend.cpp#L238-L244)).
- The OPFS backend, which has no symlinks, notes `// TODO: Propagate EPERM specifically.`
  ([opfs_backend.cpp#L322-L327](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/backends/opfs_backend.cpp#L322-L327)).

**Suggested fix:** let `insertSymlink` return a `MaybeFile`, as suggested for `insertDataFile` and `insertDirectory` in
the report on `EIO` from failed creates: still a `std::shared_ptr`, but able to carry a negative error code.
`__syscall_symlinkat` returns that code. A backend that returns plain null keeps getting `EPERM`, so
`MaybeFile::getError()` takes the code to use for an unexplained null. The Node backend passes the host's errno through,
the OPFS backend returns `-EPERM` itself, and inserting into an unlinked directory is `ENOENT`.

The diff applies on top of the one in that report, which adds `MaybeFile`:

```diff
--- a/system/lib/wasmfs/backends/ignore_case_backend.cpp
+++ b/system/lib/wasmfs/backends/ignore_case_backend.cpp
@@ -51,8 +51,8 @@
                                      mode_t mode) override;
   MaybeFile<Directory> insertDirectory(const std::string& name,
                                        mode_t mode) override;
-  std::shared_ptr<Symlink> insertSymlink(const std::string& name,
-                                         const std::string& target) override;
+  MaybeFile<Symlink> insertSymlink(const std::string& name,
+                                   const std::string& target) override;
   int insertMove(const std::string& name, std::shared_ptr<File> file) override;
   int removeChild(const std::string& name) override;
   ssize_t getNumEntries() override { return real->locked().getNumEntries(); }
@@ -127,13 +127,13 @@
   return dir;
 }

-std::shared_ptr<Symlink>
+Directory::MaybeFile<Symlink>
 IgnoreCaseDirectory::insertSymlink(const std::string& name,
                                    const std::string& target) {
   auto normalized = normalize(name);
   auto link = real->locked().insertSymlink(normalized, target);
   if (!link) {
-    return nullptr;
+    return link;
   }
   link = virtualize(link, getBackend());
   children[normalized] = {name, link};
--- a/system/lib/wasmfs/backends/node_backend.cpp
+++ b/system/lib/wasmfs/backends/node_backend.cpp
@@ -308,11 +308,11 @@
     return std::make_shared<NodeDirectory>(mode, getBackend(), childPath);
   }

-  std::shared_ptr<Symlink> insertSymlink(const std::string& name,
-                                         const std::string& target) override {
+  MaybeFile<Symlink> insertSymlink(const std::string& name,
+                                   const std::string& target) override {
     auto childPath = getChildPath(name);
-    if (_wasmfs_node_symlink(target.c_str(), childPath.c_str())) {
-      return nullptr;
+    if (auto err = _wasmfs_node_symlink(target.c_str(), childPath.c_str())) {
+      return -err;
     }
     return std::make_shared<NodeSymlink>(getBackend(), childPath);
   }
--- a/system/lib/wasmfs/backends/opfs_backend.cpp
+++ b/system/lib/wasmfs/backends/opfs_backend.cpp
@@ -319,11 +319,10 @@
     return std::make_shared<OPFSDirectory>(mode, getBackend(), childID, proxy);
   }

-  std::shared_ptr<Symlink> insertSymlink(const std::string& name,
-                                         const std::string& target) override {
+  MaybeFile<Symlink> insertSymlink(const std::string& name,
+                                   const std::string& target) override {
     // Symlinks not supported.
-    // TODO: Propagate EPERM specifically.
-    return nullptr;
+    return -EPERM;
   }

   int insertMove(const std::string& name, std::shared_ptr<File> file) override {
--- a/system/lib/wasmfs/file.cpp
+++ b/system/lib/wasmfs/file.cpp
@@ -118,16 +118,16 @@
   return child;
 }

-std::shared_ptr<Symlink>
+Directory::MaybeFile<Symlink>
 Directory::Handle::insertSymlink(const std::string& name,
                                  const std::string& target) {
   // Cannot insert into an unlinked directory.
   if (!getParent()) {
-    return nullptr;
+    return -ENOENT;
   }
   auto child = getDir()->insertSymlink(name, target);
   if (!child) {
-    return nullptr;
+    return child;
   }
   cacheChild(name, child, DCacheKind::Normal);
   updateMTime();
--- a/system/lib/wasmfs/file.h
+++ b/system/lib/wasmfs/file.h
@@ -217,8 +217,10 @@
     MaybeFile(std::shared_ptr<U> file) : std::shared_ptr<T>(std::move(file)) {}
     MaybeFile(int err) : err(err) { assert(err < 0); }

-    // A backend that returned null without saying why gets EIO.
-    int getError() const { return *this ? 0 : err ? err : -EIO; }
+    // A backend that returned null without saying why gets `unexplained`.
+    int getError(int unexplained = -EIO) const {
+      return *this ? 0 : err ? err : unexplained;
+    }
   };

 private:
@@ -260,8 +262,8 @@
                                              mode_t mode) = 0;
   virtual MaybeFile<Directory> insertDirectory(const std::string& name,
                                                mode_t mode) = 0;
-  virtual std::shared_ptr<Symlink> insertSymlink(const std::string& name,
-                                                 const std::string& target) = 0;
+  virtual MaybeFile<Symlink> insertSymlink(const std::string& name,
+                                           const std::string& target) = 0;

   // Move the file represented by `file` from its current directory to this
   // directory with the new `name`, possibly overwriting another file that
@@ -469,8 +471,8 @@
   // If the operation failed, returns nullptr and an error code.
   MaybeFile<DataFile> insertDataFile(const std::string& name, mode_t mode);
   MaybeFile<Directory> insertDirectory(const std::string& name, mode_t mode);
-  std::shared_ptr<Symlink> insertSymlink(const std::string& name,
-                                         const std::string& target);
+  MaybeFile<Symlink> insertSymlink(const std::string& name,
+                                   const std::string& target);

   // Move the file represented by `file` from its current directory to this
   // directory with the new `name`, possibly overwriting another file that
--- a/system/lib/wasmfs/memory_backend.h
+++ b/system/lib/wasmfs/memory_backend.h
@@ -83,8 +83,8 @@
     return child;
   }

-  std::shared_ptr<Symlink> insertSymlink(const std::string& name,
-                                         const std::string& target) override {
+  MaybeFile<Symlink> insertSymlink(const std::string& name,
+                                   const std::string& target) override {
     auto child = getBackend()->createSymlink(target);
     insertChild(name, child);
     return child;
--- a/system/lib/wasmfs/syscalls.cpp
+++ b/system/lib/wasmfs/syscalls.cpp
@@ -1116,10 +1116,9 @@
   if (lockedParent.getChild(childName)) {
     return -EEXIST;
   }
-  if (!lockedParent.insertSymlink(childName, target)) {
-    return -EPERM;
-  }
-  return 0;
+  // A backend that can't say why it made no symlink is taken not to support
+  // them.
+  return lockedParent.insertSymlink(childName, target).getError(-EPERM);
 }

 // TODO: Test this with non-AT_FDCWD values.
--- a/system/lib/wasmfs/virtual.h
+++ b/system/lib/wasmfs/virtual.h
@@ -70,7 +70,7 @@
                                                mode_t mode) override {
     return real->locked().insertDirectory(name, mode);
   }
-  virtual std::shared_ptr<Symlink>
+  virtual MaybeFile<Symlink>
   insertSymlink(const std::string& name, const std::string& target) override {
     return real->locked().insertSymlink(name, target);
   }
```

With both applied to 6.0.9, the test case prints, at `-O0` and `-O2`:

```
1000
symlink = -1 (Permission denied)
```

---

## Evidence

- **FAQ.** Nothing in the FAQ covers it. Run at `-O0` and `-O2`, with the same result, on nixpkgs' stock 6.0.9 and on
  ibus-web's patched one.
- **bug_reports.rst.** The source, `emcc -v`, the symptoms and a tested fix are included. Testing beyond the test case:
  ibus-web's `checks.emscripten-fixes` (the same `EACCES` case, under Node) and the IndexedDB backend's browser tests,
  where a read-only mount's `symlink()` gives `EROFS`, a quota failure `ENOSPC` and a closed database `EIO`.
  Emscripten's own test suite was not run with this patch.
- **Depends on the create-EIO report.** The diff uses its `MaybeFile` and extends its `getError()`. Filed alone, it
  would have to add the type itself.
- **Test needs a non-root user.** Root would create the symlink.
- **Duplicate search.** "wasmfs symlink", "symlinkat EPERM" and "wasmfs EPERM" turned up nothing about symlink errors;
  #17773 ("WasmFS: Error handling in OPFS backend", closed) is the nearest.
- **Why it matters to us.** ibus-web's IndexedDB backend refuses every change on a read-only mount with `EROFS`, and a
  write over the quota with `ENOSPC`; without this, `symlink()` alone says `EPERM` for both.
- **Tip-of-tree.** Checked read-only through the GitHub API on 2026-10-02: `__syscall_symlinkat` and the `insertSymlink`
  declarations in `file.h` are unchanged on `main` (a001454, 155 commits after 6.0.9) and in 6.0.10, two lines further
  down in `syscalls.cpp` on `main`. The conclusion comes from the source; `main` wasn't rebuilt.
- ibus-web carries this fix as `modules/emscripten/patches/0017-wasmfs-symlink-errors.patch`.
