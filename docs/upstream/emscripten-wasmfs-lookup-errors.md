# WasmFS: backend failures to look up a file are reported as `ENOENT`

**Still to post.** The create-`EIO` report went up as
[#27832](https://github.com/emscripten-core/emscripten/issues/27832) (2026-10-01) without the symlink and lookup halves,
so post this as its own issue citing #27832, after the symlink report; its PR goes on top of theirs. No issue or PR
filed since covers it (searches for "wasmfs getChild", "wasmfs lookup ENOENT", "wasmfs EACCES", "wasmfs ENOENT",
2026-10-02).

Checked against `main` 5977ecc (2026-10-02): `getChild()` still returns a bare `std::shared_ptr`, and 0019 applies on
`main` after 0002–0018 (not 0004, 0016) with offsets only (+2 lines); it doesn't apply alone, since it builds on 0012
and 0017. With Emscripten's runner, emsdk's toolchain for `main` (`test/emsdk_version.txt` dbaebb43: clang 24.0.0git
d3e9891b, Binaryen 133) and Node 24.21.0, `other.test_wasmfs_node_lookup_errors` fails on `main`
(`No such file or directory` for both calls) and passes with that stack.

**Draft: new issue, with a PR.** No existing issue covers it. It is the lookup half of the reports on `EIO` from failed
creates (`emscripten-wasmfs-node-create-eio.md`) and `EPERM` from failed symlinks
(`emscripten-wasmfs-symlink-errors.md`), and its fix builds on theirs; file the three together, or fold this into them.

## Issue title

WasmFS: a backend can't fail a lookup with anything but ENOENT (e.g. EACCES from the Node backend)

## Issue body

---

`Directory::getChild()` returns a bare `std::shared_ptr<File>`, and every caller takes null for "no such file". So a
lookup that fails for any other reason reads as a missing file: `stat()` and `open()` say `ENOENT`, and `mkdir()`,
`symlink()` and `open(O_CREAT)` go on to try to create the file. With the Node backend, a host `EACCES` (or `ENOTDIR`,
`ENAMETOOLONG`, `EIO`, …) comes back as "No such file or directory"; the OPFS backend drops the `EIO` it has in hand
(`// TODO: More fine-grained error reporting.`). A backend of one's own over storage that can fail (a closed database, a
network) can't say so either, and callers that branch on `ENOENT` (create the file, fall back to defaults) then act on a
file that may well exist.

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

**Test case** (`node_lookup_enoent.c`; `argv[1]` is a host directory holding an empty directory `shut`):

```c
#include <emscripten/emscripten.h>
#include <emscripten/wasmfs.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>

int main(int argc, char **argv) {
  /* argv[1]: a host directory holding a directory "shut" (mode 0755), mounted
     at /host. */
  wasmfs_create_directory("/host", 0777, wasmfs_create_node_backend(argv[1]));

  /* WasmFS keeps the mode it first finds, so it still takes "shut" for
     searchable once the host stops letting this (non-root) user search it. */
  struct stat st;
  stat("/host/shut", &st);
  EM_ASM({ require('fs').chmodSync(UTF8ToString($0) + '/shut', 0o644); }, argv[1]);

  errno = 0;
  int r = stat("/host/shut/file", &st);
  printf("stat = %d (%s)\n", r, r < 0 ? strerror(errno) : "no error");
  errno = 0;
  r = open("/host/shut/file", O_RDONLY);
  printf("open = %d (%s)\n", r, r < 0 ? strerror(errno) : "no error");

  EM_ASM({ require('fs').chmodSync(UTF8ToString($0) + '/shut', 0o755); }, argv[1]);
  return 0;
}
```

**Failing command line in full** (the same at `-O2`):

```
$ emcc -O0 -sWASMFS node_lookup_enoent.c -o node_lookup_enoent.js && mkdir -p host/shut && id -u && node node_lookup_enoent.js "$PWD/host"
1000
stat = -1 (No such file or directory)
open = -1 (No such file or directory)
```

Expected `EACCES` from both, which is what the host returned.

<details>
<summary>Full compile and link output with <code>-v</code> appended (cache and scratch paths shortened)</summary>

```
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/clang -target wasm32-unknown-emscripten -fignore-exceptions -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr --sysroot=$EM_CACHE/sysroot -resource-dir=/nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter$EM_CACHE/sysroot/include -iwithsysroot/include/c++/v1 -Xclang -iwithsysroot/include/fakesdl -Xclang -iwithsysroot/include/compat -O0 -v -c node_lookup_enoent.c -o /tmp/emscripten_temp_c_XXXXXX/node_lookup_enoent.o
clang version 22.1.8
Target: wasm32-unknown-emscripten
Thread model: posix
InstalledDir: /nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin
 (in-process)
 "/nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin/clang-22" -cc1 -triple wasm32-unknown-emscripten -O0 -emit-obj -disable-free -clear-ast-before-backend -disable-llvm-verifier -discard-value-names -main-file-name node_lookup_enoent.c -mrelocation-model static -mframe-pointer=none -ffp-contract=on -fno-rounding-math -mconstructor-aliases -target-cpu generic -fvisibility=hidden -debugger-tuning=gdb -fdebug-compilation-dir=. -v -fcoverage-compilation-dir=. -resource-dir /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter $EM_CACHE/sysroot/include -iwithsysroot /include/c++/v1 -isysroot $EM_CACHE/sysroot -internal-isystem /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/include -internal-isystem $EM_CACHE/sysroot/include/wasm32-emscripten -internal-isystem $EM_CACHE/sysroot/include -ferror-limit 19 -fgnuc-version=4.2.1 -fskip-odr-check-in-gmf -fignore-exceptions -iwithsysroot/include/fakesdl -iwithsysroot/include/compat -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr -o /tmp/emscripten_temp_c_XXXXXX/node_lookup_enoent.o -x c node_lookup_enoent.c
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
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/wasm-ld -o node_lookup_enoent.wasm /tmp/tmpXXXXXXXXlibemscripten_js_symbols.so -Bstatic --strip-debug --export=emscripten_stack_get_end --export=emscripten_stack_get_free --export=emscripten_stack_get_base --export=emscripten_stack_get_current --export=emscripten_stack_init --export=wasmfs_flush --export=_emscripten_stack_alloc --export=__wasm_call_ctors --export=_emscripten_stack_restore --export-if-defined=__start_em_asm --export-if-defined=__stop_em_asm --export-if-defined=__start_em_lib_deps --export-if-defined=__stop_em_lib_deps --export-if-defined=__start_em_js --export-if-defined=__stop_em_js --export-if-defined=main --export-if-defined=__main_argc_argv --export-if-defined=fflush --export-table -z stack-size=65536 --no-growable-memory --initial-heap=16777216 --no-entry --stack-first --table-base=1 /tmp/emscripten_temp_c_XXXXXX/node_lookup_enoent.o -L$EM_CACHE/sysroot/lib/wasm32-emscripten -L/nix/store/03iyrnrsxnbc64y6r62irmlbnbap5ya2-emscripten-6.0.9/share/emscripten/src/lib -lGL-getprocaddr -lal -lhtml5 -lstubs-debug -lnoexit -lc-debug -ldlmalloc-debug -lclang_rt.builtins -lc++-debug-noexcept -lc++abi-debug-noexcept -lsockets -lwasmfs_no_fs -lwasmfs-debug -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/llvm-objcopy node_lookup_enoent.wasm node_lookup_enoent.wasm '--remove-section=llvm.func_attr.annotate.*' --remove-section=producers --remove-section=name '--remove-section=.debug*'
 /nix/store/lfaydgacdyngci7p60s8wwvgdm74fjkx-nodejs-24.19.0/bin/node /nix/store/03iyrnrsxnbc64y6r62irmlbnbap5ya2-emscripten-6.0.9/share/emscripten/tools/compiler.mjs -
```

</details>

**Where:**

- `Directory::getChild()`, the backend's hook, and `Directory::Handle::getChild()` return a bare `std::shared_ptr<File>`
  ([file.h#L209](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/file.h#L209),
  [file.h#L391](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/file.h#L391)).
- Path parsing turns null into `-ENOENT`
  ([paths.cpp#L41-L44](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/paths.cpp#L41-L44)),
  as do `open()`, `unlinkat()`, the unmount syscall and `rename()`; `mkdir()` and `symlink()` go on to create
  ([syscalls.cpp#L454](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/syscalls.cpp#L454),
  [#L624](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/syscalls.cpp#L624),
  [#L847](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/syscalls.cpp#L847),
  [#L895](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/syscalls.cpp#L895),
  [#L1026-L1027](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/syscalls.cpp#L1026-L1027),
  [#L1104](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/syscalls.cpp#L1104)).
- The Node backend's `_wasmfs_node_get_mode` returns `1` for any host error
  ([libwasmfs_node.js#L95-L102](https://github.com/emscripten-core/emscripten/blob/6.0.9/src/lib/libwasmfs_node.js#L95-L102)),
  and `NodeDirectory::getChild()` returns null
  ([node_backend.cpp#L186-L192](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/backends/node_backend.cpp#L186-L192)).
- The OPFS backend has the lookup's error and drops it
  ([opfs_backend.cpp#L276-L285](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/backends/opfs_backend.cpp#L276-L285)).

**Suggested fix:** let `getChild()` return a `MaybeFile`, as suggested for the inserts in the reports on `EIO` from
failed creates and `EPERM` from failed symlinks: still a `std::shared_ptr`, but able to carry a negative error code.
Null with no code keeps meaning "no such file", so backends that return plain null are unchanged, and callers ask for
`getError(-ENOENT)`. Path parsing, `unlinkat()`, the unmount syscall and `rename()` (for the source) return the code;
`open()`, `mkdir()`, `symlink()` and `rename()` (for the target) fail with it rather than take the file for missing.
`FS.writeFile` fails too instead of creating the file, but `_wasmfs_write_file` returns only 0 for a failure, so the
code goes no further. The Node backend's `_wasmfs_node_get_mode` returns the host's errno (`EIO` for a host code with
none) and `getChild()` passes it on; the OPFS backend passes on everything but its "not found". The memory, fetch,
ignore-case and virtual directories change only their signatures. The preload loop in `wasmfs.cpp` still asks only
whether a child exists: it runs at start-up, before anything can be mounted, so it only looks in the root directory's
backend, which is the memory backend unless the program supplies its own root, and a memory directory's lookup can't
fail.

The diff applies on top of the ones in those two reports, which add `MaybeFile` and `getError(unexplained)`. It was made
on a tree carrying other fixes too, so some hunks sit at other lines on plain 6.0.9:

```diff
--- a/src/lib/libwasmfs_node.js
+++ b/src/lib/libwasmfs_node.js
@@ -91,15 +91,14 @@
     });
   },

-  _wasmfs_node_get_mode__deps: ['$wasmfsNodeLstat'],
-  _wasmfs_node_get_mode: (path_p, mode_p) => {
-    let stat = wasmfsNodeLstat(UTF8ToString(path_p));
-    if (stat === undefined) {
-      return 1;
-    }
+  _wasmfs_node_get_mode__deps: ['$wasmfsTry', '$wasmfsNodeFixStat'],
+  // Without ASSERTIONS, a host code with no errno converts to undefined, which
+  // must not read as success: the mode was never written.
+  _wasmfs_node_get_mode: (path_p, mode_p) => wasmfsTry(() => {
+    let stat = wasmfsNodeFixStat(fs.lstatSync(UTF8ToString(path_p)));
     {{{ makeSetValue('mode_p', 0, 'stat.mode', 'i32') }}};
-    // implicitly return 0
-  },
+    return 0;
+  }) ?? {{{ cDefs.EIO }}},

   _wasmfs_node_stat_size__deps: ['$wasmfsNodeLstat'],
   _wasmfs_node_stat_size: (path_p, size_p) => {
--- a/system/lib/wasmfs/backends/fetch_backend.cpp
+++ b/system/lib/wasmfs/backends/fetch_backend.cpp
@@ -80,7 +80,7 @@
     return dirPath + '/' + name;
   }

-  std::shared_ptr<File> getChild(const std::string& name) override {
+  MaybeFile<File> getChild(const std::string& name) override {
     return MemoryDirectory::getChild(name);
   }
 };
--- a/system/lib/wasmfs/backends/ignore_case_backend.cpp
+++ b/system/lib/wasmfs/backends/ignore_case_backend.cpp
@@ -46,7 +46,7 @@
   IgnoreCaseDirectory(std::shared_ptr<Directory> real, backend_t backend)
     : VirtualDirectory(real, backend) {}

-  std::shared_ptr<File> getChild(const std::string& name) override;
+  MaybeFile<File> getChild(const std::string& name) override;
   MaybeFile<DataFile> insertDataFile(const std::string& name,
                                      mode_t mode) override;
   MaybeFile<Directory> insertDirectory(const std::string& name,
@@ -89,14 +89,15 @@
   WASMFS_UNREACHABLE("unexpected file kind");
 }

-std::shared_ptr<File> IgnoreCaseDirectory::getChild(const std::string& name) {
+Directory::MaybeFile<File>
+IgnoreCaseDirectory::getChild(const std::string& name) {
   auto normalized = normalize(name);
   if (auto it = children.find(normalized); it != children.end()) {
     return it->second.child;
   }
   auto child = real->locked().getChild(normalized);
   if (!child) {
-    return nullptr;
+    return child;
   }
   child = virtualize(child, getBackend());
   children[normalized] = {name, child};
--- a/system/lib/wasmfs/backends/memory_backend.cpp
+++ b/system/lib/wasmfs/backends/memory_backend.cpp
@@ -42,7 +42,8 @@
   });
 }

-std::shared_ptr<File> MemoryDirectory::getChild(const std::string& name) {
+Directory::MaybeFile<File>
+MemoryDirectory::getChild(const std::string& name) {
   if (auto entry = findEntry(name); entry != entries.end()) {
     return entry->child;
   }
--- a/system/lib/wasmfs/backends/node_backend.cpp
+++ b/system/lib/wasmfs/backends/node_backend.cpp
@@ -253,13 +253,13 @@
     }
   }

-  std::shared_ptr<File> getChild(const std::string& name) override {
+  MaybeFile<File> getChild(const std::string& name) override {
     static_assert(std::is_same_v<mode_t, unsigned int>);
     // TODO: also retrieve and set ctime, atime, ino, etc.
     auto childPath = getChildPath(name);
     mode_t mode;
-    if (_wasmfs_node_get_mode(childPath.c_str(), &mode)) {
-      return nullptr;
+    if (auto err = _wasmfs_node_get_mode(childPath.c_str(), &mode)) {
+      return -err;
     }
     // Allow reading from character device files too (e.g. `/dev/random`,
     // `/dev/urandom`)
--- a/system/lib/wasmfs/backends/opfs_backend.cpp
+++ b/system/lib/wasmfs/backends/opfs_backend.cpp
@@ -273,15 +273,18 @@
   }

 private:
-  std::shared_ptr<File> getChild(const std::string& name) override {
+  MaybeFile<File> getChild(const std::string& name) override {
     int childType = 0, childID = 0;
     proxy([&](auto ctx) {
       _wasmfs_opfs_get_child(
         ctx.ctx, dirID, name.c_str(), &childType, &childID);
     });
+    // The lookup reports a missing child as EEXIST, since it can also create.
+    if (childID == -EEXIST) {
+      return nullptr;
+    }
     if (childID < 0) {
-      // TODO: More fine-grained error reporting.
-      return NULL;
+      return childID;
     }
     if (childType == 1) {
       return std::make_shared<OPFSFile>(0777, getBackend(), childID, proxy);
--- a/system/lib/wasmfs/file.cpp
+++ b/system/lib/wasmfs/file.cpp
@@ -51,7 +51,8 @@
   child->locked().setParent(getDir());
 }

-std::shared_ptr<File> Directory::Handle::getChild(const std::string& name) {
+Directory::MaybeFile<File>
+Directory::Handle::getChild(const std::string& name) {
   // Unlinked directories must be empty, without even "." or ".."
   if (!getParent()) {
     return nullptr;
@@ -71,7 +72,7 @@
   // know about.
   auto child = getDir()->getChild(name);
   if (!child) {
-    return nullptr;
+    return child;
   }
   cacheChild(name, child, DCacheKind::Normal);
   return child;
--- a/system/lib/wasmfs/file.h
+++ b/system/lib/wasmfs/file.h
@@ -206,7 +206,7 @@
     }
   };

-  // A newly created file, or null and a negative error code. It is still a
+  // A file, or null and a negative error code. It is still a
   // `std::shared_ptr`, so callers that only check for null need not change.
   template<class T> class MaybeFile : public std::shared_ptr<T> {
     int err = 0;
@@ -250,9 +250,9 @@
     return children;
   }

-  // Return the `File` object corresponding to the file with the given name or
-  // null if there is none.
-  virtual std::shared_ptr<File> getChild(const std::string& name) = 0;
+  // Return the `File` object corresponding to the file with the given name,
+  // null if there is none, or a negative error code if the lookup failed.
+  virtual MaybeFile<File> getChild(const std::string& name) = 0;

   // Inserts a file with the given name, kind, and mode. Returns a `File` object
   // corresponding to the newly created file or nullptr if the new file could
@@ -457,8 +457,9 @@
     : File::Handle(directory, std::defer_lock) {}

   // Retrieve the child if it is in the dcache and otherwise forward the request
-  // to the backend, caching any `File` object it returns.
-  std::shared_ptr<File> getChild(const std::string& name);
+  // to the backend, caching any `File` object it returns. Null with no error
+  // code means there is no such child.
+  MaybeFile<File> getChild(const std::string& name);

   // Add a child to this directory's entry cache without actually inserting it
   // in the underlying backend. Assumes a child with this name does not already
--- a/system/lib/wasmfs/js_api.cpp
+++ b/system/lib/wasmfs/js_api.cpp
@@ -75,9 +75,14 @@
   std::shared_ptr<File> child;
   {
     auto lockedParent = parent->locked();
-    child = lockedParent.getChild(childName);
+    auto found = lockedParent.getChild(childName);
+    child = found;
     if (!child) {
-      // Lookup failed; try creating the file.
+      if (found.getError(-ENOENT) != -ENOENT) {
+        // The lookup failed rather than finding nothing.
+        return 0;
+      }
+      // Nothing there; try creating the file.
       child = lockedParent.insertDataFile(childName, 0777);
       if (!child) {
         // File creation failed; nothing else to do.
--- a/system/lib/wasmfs/memory_backend.h
+++ b/system/lib/wasmfs/memory_backend.h
@@ -65,7 +65,7 @@
     entries.push_back({name, child});
   }

-  std::shared_ptr<File> getChild(const std::string& name) override;
+  MaybeFile<File> getChild(const std::string& name) override;

   int removeChild(const std::string& name) override;

--- a/system/lib/wasmfs/paths.cpp
+++ b/system/lib/wasmfs/paths.cpp
@@ -40,7 +40,7 @@
                     size_t& recursions) {
   auto child = dir->locked().getChild(std::string(name));
   if (!child) {
-    return -ENOENT;
+    return child.getError(-ENOENT);
   }
   if (links != NoFollowLinks) {
     while (auto link = child->dynCast<Symlink>()) {
--- a/system/lib/wasmfs/syscalls.cpp
+++ b/system/lib/wasmfs/syscalls.cpp
@@ -451,7 +451,12 @@
   std::shared_ptr<File> child;
   {
     auto lockedParent = parent->locked();
-    child = lockedParent.getChild(std::string(childName));
+    auto found = lockedParent.getChild(std::string(childName));
+    child = found;
+    // A lookup that failed, rather than finding nothing, fails the open too.
+    if (auto err = found.getError(-ENOENT); err && err != -ENOENT) {
+      return err;
+    }
     // The requested node was not found.
     if (!child) {
       // If curr is the last element and the create flag is specified
@@ -632,9 +637,13 @@
   }

   // Check if the requested directory already exists.
-  if (lockedParent.getChild(childName)) {
+  auto existing = lockedParent.getChild(childName);
+  if (existing) {
     return -EEXIST;
   }
+  if (auto err = existing.getError(-ENOENT); err != -ENOENT) {
+    return err;
+  }

   // Mask rwx permissions for user, group and others, and the sticky bit.
   // This prevents users from entering S_IFREG for example.
@@ -858,7 +867,7 @@
   auto lockedParent = parent->locked();
   auto file = lockedParent.getChild(childName);
   if (!file) {
-    return -ENOENT;
+    return file.getError(-ENOENT);
   }
   // Disallow removing the root directory, even if it is empty.
   if (file == wasmFS.getRootDirectory()) {
@@ -906,7 +915,7 @@
   auto lockedParent = parent->locked();
   auto file = lockedParent.getChild(childName);
   if (!file) {
-    return -ENOENT;
+    return file.getError(-ENOENT);
   }
   // Disallow removing the root directory, even if it is empty.
   if (file == wasmFS.getRootDirectory()) {
@@ -1039,7 +1048,10 @@
   auto newFile = lockedNewParent.getChild(newFileName);

   if (!oldFile) {
-    return -ENOENT;
+    return oldFile.getError(-ENOENT);
+  }
+  if (auto err = newFile.getError(-ENOENT); err && err != -ENOENT) {
+    return err;
   }

   // If the source and destination are the same, do nothing.
@@ -1113,9 +1125,13 @@
   }
   auto lockedParent = parent->locked();
   std::string childName(childNameView);
-  if (lockedParent.getChild(childName)) {
+  auto existing = lockedParent.getChild(childName);
+  if (existing) {
     return -EEXIST;
   }
+  if (auto err = existing.getError(-ENOENT); err != -ENOENT) {
+    return err;
+  }
   // A backend that can't say why it made no symlink is taken not to support
   // them.
   return lockedParent.insertSymlink(childName, target).getError(-EPERM);
--- a/system/lib/wasmfs/virtual.h
+++ b/system/lib/wasmfs/virtual.h
@@ -59,7 +59,7 @@
     : Directory(real->locked().getMode(), backend), real(real) {}

 protected:
-  virtual std::shared_ptr<File> getChild(const std::string& name) override {
+  virtual MaybeFile<File> getChild(const std::string& name) override {
     return real->locked().getChild(name);
   }
   virtual MaybeFile<DataFile> insertDataFile(const std::string& name,
```

With it applied, the test case prints, at `-O0` and `-O2`:

```
1000
stat = -1 (Permission denied)
open = -1 (Permission denied)
```

**Test for the PR,** in the suite's format (also as `emscripten-wasmfs-lookup-errors.tests.patch` beside this draft):

```diff
--- a/test/test_other.py
+++ b/test/test_other.py
@@ -13867,6 +13867,43 @@
     create_file('js_backend_files/file.dat', 'data')
     self.do_runf_out_file('wasmfs/wasmfs_before_preload.c', cflags=['--preload-file', 'js_backend_files/file.dat'])

+  @requires_node
+  def test_wasmfs_node_lookup_errors(self):
+    # A lookup the host refuses reports the host's error, not ENOENT, which
+    # callers would take for a missing file.
+    if not hasattr(os, 'geteuid') or os.geteuid() == 0:
+      self.skipTest('needs a non-root POSIX user, whom file permissions bind')
+    self.set_setting('WASMFS')
+    os.mkdir('host')
+    os.mkdir('host/shut')
+    create_file('main.c', r'''
+      #include <emscripten/emscripten.h>
+      #include <emscripten/wasmfs.h>
+      #include <errno.h>
+      #include <fcntl.h>
+      #include <stdio.h>
+      #include <string.h>
+      #include <sys/stat.h>
+
+      int main() {
+        wasmfs_create_directory("/host", 0777, wasmfs_create_node_backend("host"));
+        // WasmFS keeps the mode it first finds, so it still takes "shut" for
+        // searchable once the host stops letting us search it.
+        struct stat st;
+        stat("/host/shut", &st);
+        EM_ASM(require('fs').chmodSync('host/shut', 0o644));
+        errno = 0;
+        int r = stat("/host/shut/file", &st);
+        printf("stat: %s\n", r < 0 ? strerror(errno) : "no error");
+        errno = 0;
+        r = open("/host/shut/file", O_RDONLY);
+        printf("open: %s\n", r < 0 ? strerror(errno) : "no error");
+        EM_ASM(require('fs').chmodSync('host/shut', 0o755));
+        return 0;
+      }
+    ''')
+    self.do_runf('main.c', 'stat: Permission denied\nopen: Permission denied\n')
+
   def test_hello_world_above_2gb(self):
     self.do_runf_out_file('hello_world.c', cflags=['-sGLOBAL_BASE=2GB', '-sINITIAL_MEMORY=3GB'])

```

---

## Evidence

- **FAQ.** Nothing in the FAQ covers it. Run at `-O0` and `-O2`, with the same result, on nixpkgs' stock 6.0.9 and on
  ibus-web's toolchain with patches 0001–0018; with 0019 as well, `EACCES`.
- **bug_reports.rst.** The source, `emcc -v`, the symptoms, a tested fix and a test are included. Testing beyond the
  test case: the test above passes on Emscripten's own runner with ibus-web's whole stack (0001–0019) and fails on stock
  6.0.9; a 192-test WasmFS selection (`other.test_wasmfs*`, `other.test_unistd*`, `wasmfs.test_unistd*`, `test_fcntl*`,
  `test_stat*`, `test_fs_*`, `test_dirent*`) has the same eleven failures on both, all from the environment, and no
  others. Those runs predate the Node backend's `EIO` fallback and a reworded comment in `js_api.cpp`; the fallback
  changes nothing on a host code that has an errno. ibus-web's `checks.emscripten-fixes` runs the same case under Node,
  and the IndexedDB backend's browser tests check that a lookup in a closed database is `EIO`.
- **Depends on the create-EIO and symlink reports.** The diff uses their `MaybeFile` and `getError(unexplained)`. Filed
  alone, it would have to add them itself.
- **Test needs a non-root user.** Root searches the directory anyway.
- **Duplicate search.** "wasmfs getChild", "wasmfs ENOENT", "wasmfs EACCES" and "wasmfs lookup error" turned up nothing;
  #17773 ("WasmFS: Error handling in OPFS backend", closed) is the nearest.
- **Why it matters to us.** ibus-web's IndexedDB backend fails every call with `EIO` once its database closes for a
  version change. Without this, a lookup there says `ENOENT`, and an engine would create a file that exists, fall back
  to defaults, or start an empty user dictionary.
- **Tip-of-tree.** Checked read-only through the GitHub API on 2026-10-02: both `getChild()` declarations in `file.h`,
  the `-ENOENT` in `paths.cpp` and `_wasmfs_node_get_mode`'s `return 1` are unchanged on `main` (fd9124b, 160 commits
  after 6.0.9) and in 6.0.10. The conclusion comes from the source; `main` wasn't rebuilt.
- ibus-web carries this fix as `modules/emscripten/patches/0019-wasmfs-lookup-errors.patch`.
