# WasmFS: backend failures to create a file or directory are reported as `EIO`

**Draft: new issue (low priority).** No existing issue covers it. The source
already admits the gap with a TODO at each site, so this is more a request to
track it than a bug report. Consider skipping it, or filing it only together
with the other Node backend reports.

## Issue title

WasmFS: mkdir()/open(O_CREAT) report EIO for any backend failure (e.g. EACCES from the Node backend)

## Issue body

---

When a backend fails to create a file or directory, WasmFS returns `EIO`
whatever the cause. With the Node backend, a host `EACCES` (or `EROFS`,
`ENOSPC`, `EDQUOT`, …) comes back as "I/O error". Callers that handle
`EACCES`/`EEXIST`/`ENOSPC` specially can't tell what happened.

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

**Test case** (`node_create_eio.c`; `argv[1]` is a host directory the
non-root user can't write to):

```c
#include <emscripten/wasmfs.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

int main(int argc, char **argv) {
  /* argv[1]: a host directory this (non-root) user cannot write to, mounted
     at /host. */
  wasmfs_create_directory("/host", 0777, wasmfs_create_node_backend(argv[1]));

  errno = 0;
  int r = mkdir("/host/dir", 0777);
  printf("mkdir = %d (%s)\n", r, r < 0 ? strerror(errno) : "no error");
  errno = 0;
  int fd = open("/host/file", O_CREAT | O_WRONLY, 0644);
  printf("open(O_CREAT) = %d (%s)\n", fd, fd < 0 ? strerror(errno) : "no error");
  return 0;
}
```

**Failing command line in full** (the same at `-O2`):

```
$ emcc -O0 -sWASMFS node_create_eio.c -o node_create_eio.js && mkdir -m 0555 host && id -u && node node_create_eio.js "$PWD/host"
1000
mkdir = -1 (I/O error)
open(O_CREAT) = -1 (I/O error)
```

Expected `EACCES` for both, which is what the host returned.

WasmFS's own permission check doesn't catch this. The mount point's mode is the
`0777` given to `wasmfs_create_directory`, not the host's `0555`. The same
happens in host directories owned by another user: WasmFS's check passes if any
write bit (`0222`) is set, ignoring ownership.

<details>
<summary>Full compile and link output with <code>-v</code> appended (cache and scratch paths shortened)</summary>

```
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/clang -target wasm32-unknown-emscripten -fignore-exceptions -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr --sysroot=$EM_CACHE/sysroot -resource-dir=/nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter$EM_CACHE/sysroot/include -iwithsysroot/include/c++/v1 -Xclang -iwithsysroot/include/fakesdl -Xclang -iwithsysroot/include/compat -v -O0 -c node_create_eio.c -o /tmp/emscripten_temp_c_mnl45n/node_create_eio.o
clang version 22.1.8
Target: wasm32-unknown-emscripten
Thread model: posix
InstalledDir: /nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin
 (in-process)
 "/nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin/clang-22" -cc1 -triple wasm32-unknown-emscripten -O0 -emit-obj -disable-free -clear-ast-before-backend -disable-llvm-verifier -discard-value-names -main-file-name node_create_eio.c -mrelocation-model static -mframe-pointer=none -ffp-contract=on -fno-rounding-math -mconstructor-aliases -target-cpu generic -fvisibility=hidden -debugger-tuning=gdb -fdebug-compilation-dir=. -v -fcoverage-compilation-dir=. -resource-dir /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter $EM_CACHE/sysroot/include -iwithsysroot /include/c++/v1 -isysroot $EM_CACHE/sysroot -internal-isystem /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/include -internal-isystem $EM_CACHE/sysroot/include/wasm32-emscripten -internal-isystem $EM_CACHE/sysroot/include -ferror-limit 19 -fgnuc-version=4.2.1 -fskip-odr-check-in-gmf -fignore-exceptions -iwithsysroot/include/fakesdl -iwithsysroot/include/compat -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr -o /tmp/emscripten_temp_c_mnl45n/node_create_eio.o -x c node_create_eio.c
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
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/wasm-ld -o node_create_eio.wasm /tmp/tmpqts1cufjlibemscripten_js_symbols.so -Bstatic --strip-debug --export=emscripten_stack_get_end --export=emscripten_stack_get_free --export=emscripten_stack_get_base --export=emscripten_stack_get_current --export=emscripten_stack_init --export=wasmfs_flush --export=_emscripten_stack_alloc --export=__wasm_call_ctors --export=_emscripten_stack_restore --export-if-defined=__start_em_asm --export-if-defined=__stop_em_asm --export-if-defined=__start_em_lib_deps --export-if-defined=__stop_em_lib_deps --export-if-defined=__start_em_js --export-if-defined=__stop_em_js --export-if-defined=main --export-if-defined=__main_argc_argv --export-if-defined=fflush --export-table -z stack-size=65536 --no-growable-memory --initial-heap=16777216 --no-entry --stack-first --table-base=1 /tmp/emscripten_temp_c_mnl45n/node_create_eio.o -L$EM_CACHE/sysroot/lib/wasm32-emscripten -L/nix/store/03iyrnrsxnbc64y6r62irmlbnbap5ya2-emscripten-6.0.9/share/emscripten/src/lib -lGL-getprocaddr -lal -lhtml5 -lstubs-debug -lnoexit -lc-debug -ldlmalloc-debug -lclang_rt.builtins -lc++-debug-noexcept -lc++abi-debug-noexcept -lsockets -lwasmfs_no_fs -lwasmfs-debug -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/llvm-objcopy node_create_eio.wasm node_create_eio.wasm '--remove-section=llvm.func_attr.annotate.*' --remove-section=producers --remove-section=name '--remove-section=.debug*'
```

</details>

**Where:**

- `doOpen` and `doMkdir` turn a null result from the backend's
  `insertDataFile`/`insertDirectory` (or `createFile`/`createDirectory`) into
  `-EIO`, under `// TODO Receive a specific error code, and report it here`
  ([syscalls.cpp#L480-L493](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/syscalls.cpp#L480-L493),
  [#L645-L657](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/syscalls.cpp#L645-L657)).
- The Node backend has the host's errno in hand and drops it
  ([node_backend.cpp#L220-L236](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/backends/node_backend.cpp#L220-L236)).

**Suggested fix:** let `Directory`'s insert functions return a
`MaybeFile`: still a `std::shared_ptr`, so callers that only check for null
don't change, but able to carry a negative error code, much as `getEntries`
returns `MaybeEntries`. `doOpen` and `doMkdir` return that code; a backend
that returns plain null still gets `EIO`. The Node backend passes the host's
errno through, and inserting into an unlinked directory is `ENOENT`.
`Backend::create*` (used for mounts) is left alone.

```diff
--- a/system/lib/wasmfs/backends/fetch_backend.cpp
+++ b/system/lib/wasmfs/backends/fetch_backend.cpp
@@ -58,8 +58,8 @@
                  emscripten::ProxyWorker& proxy)
     : MemoryDirectory(mode, backend), dirPath(path), proxy(proxy) {}

-  std::shared_ptr<DataFile> insertDataFile(const std::string& name,
-                                           mode_t mode) override {
+  MaybeFile<DataFile> insertDataFile(const std::string& name,
+                                     mode_t mode) override {
     auto childPath = getChildPath(name);
     auto child =
       std::make_shared<FetchFile>(childPath, mode, getBackend(), proxy);
@@ -67,8 +67,8 @@
     return child;
   }

-  std::shared_ptr<Directory> insertDirectory(const std::string& name,
-                                             mode_t mode) override {
+  MaybeFile<Directory> insertDirectory(const std::string& name,
+                                       mode_t mode) override {
     auto childPath = getChildPath(name);
     auto childDir =
       std::make_shared<FetchDirectory>(childPath, mode, getBackend(), proxy);
--- a/system/lib/wasmfs/backends/ignore_case_backend.cpp
+++ b/system/lib/wasmfs/backends/ignore_case_backend.cpp
@@ -47,10 +47,10 @@
     : VirtualDirectory(real, backend) {}

   std::shared_ptr<File> getChild(const std::string& name) override;
-  std::shared_ptr<DataFile> insertDataFile(const std::string& name,
-                                           mode_t mode) override;
-  std::shared_ptr<Directory> insertDirectory(const std::string& name,
-                                             mode_t mode) override;
+  MaybeFile<DataFile> insertDataFile(const std::string& name,
+                                     mode_t mode) override;
+  MaybeFile<Directory> insertDirectory(const std::string& name,
+                                       mode_t mode) override;
   std::shared_ptr<Symlink> insertSymlink(const std::string& name,
                                          const std::string& target) override;
   int insertMove(const std::string& name, std::shared_ptr<File> file) override;
@@ -103,24 +103,24 @@
   return child;
 }

-std::shared_ptr<DataFile>
+Directory::MaybeFile<DataFile>
 IgnoreCaseDirectory::insertDataFile(const std::string& name, mode_t mode) {
   auto normalized = normalize(name);
   auto file = real->locked().insertDataFile(normalized, mode);
   if (!file) {
-    return nullptr;
+    return file;
   }
   file = virtualize(file, getBackend());
   children[normalized] = {name, file};
   return file;
 }

-std::shared_ptr<Directory>
+Directory::MaybeFile<Directory>
 IgnoreCaseDirectory::insertDirectory(const std::string& name, mode_t mode) {
   auto normalized = normalize(name);
   auto dir = real->locked().insertDirectory(normalized, mode);
   if (!dir) {
-    return nullptr;
+    return dir;
   }
   dir = virtualize(dir, getBackend());
   children[normalized] = {name, dir};
--- a/system/lib/wasmfs/backends/node_backend.cpp
+++ b/system/lib/wasmfs/backends/node_backend.cpp
@@ -263,23 +263,23 @@
     return 0;
   }

-  std::shared_ptr<DataFile> insertDataFile(const std::string& name,
-                                           mode_t mode) override {
+  MaybeFile<DataFile> insertDataFile(const std::string& name,
+                                     mode_t mode) override {
     auto childPath = getChildPath(name);
     int fd = _wasmfs_node_insert_file(childPath.c_str(), mode);
     if (fd < 0) {
-      return nullptr;
+      return fd;
     }
     auto file = std::make_shared<NodeFile>(mode, getBackend(), childPath);
     file->state.keepCreated(fd);
     return file;
   }

-  std::shared_ptr<Directory> insertDirectory(const std::string& name,
-                                             mode_t mode) override {
+  MaybeFile<Directory> insertDirectory(const std::string& name,
+                                       mode_t mode) override {
     auto childPath = getChildPath(name);
-    if (_wasmfs_node_insert_directory(childPath.c_str(), mode)) {
-      return nullptr;
+    if (auto err = _wasmfs_node_insert_directory(childPath.c_str(), mode)) {
+      return -err;
     }
     return std::make_shared<NodeDirectory>(mode, getBackend(), childPath);
   }
--- a/system/lib/wasmfs/backends/opfs_backend.cpp
+++ b/system/lib/wasmfs/backends/opfs_backend.cpp
@@ -293,8 +293,8 @@
     }
   }

-  std::shared_ptr<DataFile> insertDataFile(const std::string& name,
-                                           mode_t mode) override {
+  MaybeFile<DataFile> insertDataFile(const std::string& name,
+                                     mode_t mode) override {
     int childID = 0;
     proxy([&](auto ctx) {
       _wasmfs_opfs_insert_file(ctx.ctx, dirID, name.c_str(), &childID);
@@ -306,8 +306,8 @@
     return std::make_shared<OPFSFile>(mode, getBackend(), childID, proxy);
   }

-  std::shared_ptr<Directory> insertDirectory(const std::string& name,
-                                             mode_t mode) override {
+  MaybeFile<Directory> insertDirectory(const std::string& name,
+                                       mode_t mode) override {
     int childID = 0;
     proxy([&](auto ctx) {
       _wasmfs_opfs_insert_directory(ctx.ctx, dirID, name.c_str(), &childID);
--- a/system/lib/wasmfs/file.cpp
+++ b/system/lib/wasmfs/file.cpp
@@ -88,30 +88,30 @@
   return true;
 }

-std::shared_ptr<DataFile>
+Directory::MaybeFile<DataFile>
 Directory::Handle::insertDataFile(const std::string& name, mode_t mode) {
   // Cannot insert into an unlinked directory.
   if (!getParent()) {
-    return nullptr;
+    return -ENOENT;
   }
   auto child = getDir()->insertDataFile(name, mode);
   if (!child) {
-    return nullptr;
+    return child;
   }
   cacheChild(name, child, DCacheKind::Normal);
   updateMTime();
   return child;
 }

-std::shared_ptr<Directory>
+Directory::MaybeFile<Directory>
 Directory::Handle::insertDirectory(const std::string& name, mode_t mode) {
   // Cannot insert into an unlinked directory.
   if (!getParent()) {
-    return nullptr;
+    return -ENOENT;
   }
   auto child = getDir()->insertDirectory(name, mode);
   if (!child) {
-    return nullptr;
+    return child;
   }
   cacheChild(name, child, DCacheKind::Normal);
   updateMTime();
--- a/system/lib/wasmfs/file.h
+++ b/system/lib/wasmfs/file.h
@@ -194,6 +194,21 @@
     }
   };

+  // A newly created file, or null and a negative error code. It is still a
+  // `std::shared_ptr`, so callers that only check for null need not change.
+  template<class T> class MaybeFile : public std::shared_ptr<T> {
+    int err = 0;
+
+  public:
+    MaybeFile(std::nullptr_t = nullptr) {}
+    template<class U>
+    MaybeFile(std::shared_ptr<U> file) : std::shared_ptr<T>(std::move(file)) {}
+    MaybeFile(int err) : err(err) { assert(err < 0); }
+
+    // A backend that returned null without saying why gets EIO.
+    int getError() const { return *this ? 0 : err ? err : -EIO; }
+  };
+
 private:
   // The directory cache, or `dcache`, stores `File` objects for the children of
   // each directory so that subsequent lookups do not need to query the backend.
@@ -228,11 +243,11 @@
   // Inserts a file with the given name, kind, and mode. Returns a `File` object
   // corresponding to the newly created file or nullptr if the new file could
   // not be created. Assumes a child with this name does not already exist.
-  // If the operation failed, returns nullptr.
-  virtual std::shared_ptr<DataFile> insertDataFile(const std::string& name,
-                                                   mode_t mode) = 0;
-  virtual std::shared_ptr<Directory> insertDirectory(const std::string& name,
-                                                     mode_t mode) = 0;
+  // If the operation failed, returns nullptr or a negative error code.
+  virtual MaybeFile<DataFile> insertDataFile(const std::string& name,
+                                             mode_t mode) = 0;
+  virtual MaybeFile<Directory> insertDirectory(const std::string& name,
+                                               mode_t mode) = 0;
   virtual std::shared_ptr<Symlink> insertSymlink(const std::string& name,
                                                  const std::string& target) = 0;

@@ -417,11 +432,9 @@
   // Insert a child of the given name, kind, and mode in the underlying backend,
   // which will allocate and return a corresponding `File` on success or return
   // nullptr otherwise. Assumes a child with this name does not already exist.
-  // If the operation failed, returns nullptr.
-  std::shared_ptr<DataFile> insertDataFile(const std::string& name,
-                                           mode_t mode);
-  std::shared_ptr<Directory> insertDirectory(const std::string& name,
-                                             mode_t mode);
+  // If the operation failed, returns nullptr and an error code.
+  MaybeFile<DataFile> insertDataFile(const std::string& name, mode_t mode);
+  MaybeFile<Directory> insertDirectory(const std::string& name, mode_t mode);
   std::shared_ptr<Symlink> insertSymlink(const std::string& name,
                                          const std::string& target);

--- a/system/lib/wasmfs/memory_backend.h
+++ b/system/lib/wasmfs/memory_backend.h
@@ -69,15 +69,15 @@

   int removeChild(const std::string& name) override;

-  std::shared_ptr<DataFile> insertDataFile(const std::string& name,
-                                           mode_t mode) override {
+  MaybeFile<DataFile> insertDataFile(const std::string& name,
+                                     mode_t mode) override {
     auto child = getBackend()->createFile(mode);
     insertChild(name, child);
     return child;
   }

-  std::shared_ptr<Directory> insertDirectory(const std::string& name,
-                                             mode_t mode) override {
+  MaybeFile<Directory> insertDirectory(const std::string& name,
+                                       mode_t mode) override {
     auto child = getBackend()->createDirectory(mode);
     insertChild(name, child);
     return child;
--- a/system/lib/wasmfs/syscalls.cpp
+++ b/system/lib/wasmfs/syscalls.cpp
@@ -480,12 +480,12 @@
       }
       std::shared_ptr<File> created;
       if (backend == parent->getBackend()) {
-        created = lockedParent.insertDataFile(std::string(childName), mode);
-        if (!created) {
-          // TODO Receive a specific error code, and report it here. For now,
-          //      report a generic error.
-          return -EIO;
+        auto inserted =
+          lockedParent.insertDataFile(std::string(childName), mode);
+        if (auto err = inserted.getError()) {
+          return err;
         }
+        created = inserted;
       } else {
         created = backend->createFile(mode);
         if (!created) {
@@ -645,10 +645,8 @@
   }

   if (backend == parent->getBackend()) {
-    if (!lockedParent.insertDirectory(childName, mode)) {
-      // TODO Receive a specific error code, and report it here. For now, report
-      //      a generic error.
-      return -EIO;
+    if (auto err = lockedParent.insertDirectory(childName, mode).getError()) {
+      return err;
     }
   } else {
     auto created = backend->createDirectory(mode);
--- a/system/lib/wasmfs/virtual.h
+++ b/system/lib/wasmfs/virtual.h
@@ -62,12 +62,12 @@
   virtual std::shared_ptr<File> getChild(const std::string& name) override {
     return real->locked().getChild(name);
   }
-  virtual std::shared_ptr<DataFile> insertDataFile(const std::string& name,
-                                                   mode_t mode) override {
+  virtual MaybeFile<DataFile> insertDataFile(const std::string& name,
+                                             mode_t mode) override {
     return real->locked().insertDataFile(name, mode);
   }
-  virtual std::shared_ptr<Directory> insertDirectory(const std::string& name,
-                                                     mode_t mode) override {
+  virtual MaybeFile<Directory> insertDirectory(const std::string& name,
+                                               mode_t mode) override {
     return real->locked().insertDirectory(name, mode);
   }
   virtual std::shared_ptr<Symlink>
```

(The Node backend's `insertDataFile` here builds on the `open`/`close` fix
reported separately, where `_wasmfs_node_insert_file` returns the
descriptor that created the file, or a negated errno.)

With this applied to 6.0.9, the test case prints, at `-O0` and `-O2`:

```
1000
mkdir = -1 (Permission denied)
open(O_CREAT) = -1 (Permission denied)
```

It was also tested for `EROFS` (a read-only mount), `EEXIST` (a FIFO in the
way, which WasmFS doesn't list), `ENOENT` (a parent removed behind WasmFS's
back, and an unlinked directory), `ENAMETOOLONG` and `ENOSPC` (a full
tmpfs). Emscripten's own WasmFS tests (a 96-test selection) give the same
results as without it.

---

## Notes for the user

- **FAQ.** Nothing in the FAQ covers it. Run at `-O0` and `-O2`, with the same
  result. The TODOs show the maintainers know. Whether a tracking issue is
  welcome is a judgement call; `bug_reports.rst` doesn't say.
- **bug_reports.rst.** The source, `emcc -v`, the symptoms and a tested fix
  are included. The `MaybeFile` type is one way to shape the interface
  change; maintainers may prefer another.
- **Test needs a non-root user.** Root would create the files.
- **Overlap with other drafts.** For `open(O_CREAT)`, fixing #18033 (see
  `emscripten-wasmfs-create-permission.md`) makes WasmFS answer `EACCES` itself
  whenever its idea of the directory's mode is right. This report covers the
  rest: mount points, directories owned by someone else (WasmFS ignores
  ownership) and non-permission errors.
- **Duplicate search.** "wasmfs EIO", "wasmfs I/O error", "wasmfs mkdir EIO",
  "Receive a specific error code", "wasmfs node backend" and "EACCES", plus a
  scan of all open "wasmfs" issues, turned up #17773 ("WasmFS: Error handling
  in OPFS backend", closed) and nothing about creation errors.
- **Why it matters to us.** GLib's `/fileutils/mkdir-with-parents` expects
  `EACCES` creating under `/usr` in the build sandbox. It got `EIO` until
  `modules/toolchain/node-host-fs.c` started `chmod`ing the WasmFS root to the
  host's mode; with this fix that emulation is gone, and the chmod fix
  needs this one, or the test gets `EIO` again.
- **Tip-of-tree.** Checked read-only through the GitHub API on 2026-09-30:
  `node_backend.cpp` and `libwasmfs_node.js` are unchanged between 6.0.9 and
  `main` (2151200, 139 commits later). `syscalls.cpp` changed only in
  `fdatasync`'s error sign (#27806) and `utimensat`'s timestamp rounding; the
  cited code is unchanged, a few lines further down. The latest release, 6.0.10
  (tagged 2026-09-18), matches. The conclusion comes from the diff; `main`
  wasn't rebuilt. Our build is nixpkgs' 6.0.9 with LLVM 22.1.8.
- ibus-web carries this fix as `modules/emscripten/patches/0012-wasmfs-node-create-eio.patch`.
