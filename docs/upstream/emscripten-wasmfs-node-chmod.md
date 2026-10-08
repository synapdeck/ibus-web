# WasmFS Node backend: `chmod()` (and `utimensat()`) never reach the host

**Posted: don't post again.** Filed as
[#27823](https://github.com/emscripten-core/emscripten/issues/27823)
(2026-10-01, no replies yet). The `futimens()` fix at its end (patch 0008) is
PR [#27845](https://github.com/emscripten-core/emscripten/pull/27845),
approved by sbc100 on 2026-10-01 and not merged yet. The chmod/utimensat fix
itself (0013) can follow as a PR once #27825's and #27832's are in, since it
builds on 0010 and 0012.

Checked against `main` 5977ecc (2026-10-02): the Node backend is unchanged
since 6.0.9; `utimensat()`'s timestamp conversion was reworked (#27786,
#27794), not its effect on the host. 0008 applies alone exactly; 0013
applies after 0002–0012 (not 0004) with 5-line offsets and not alone (it
needs 0009's `libsigs.js` lines).

**As posted** (what #27823 says, kept for reference). When drafted, no existing issue covered it.

## Issue title

WasmFS Node backend: chmod() and utimensat() only change WasmFS's in-memory metadata, not the host file

## Issue body

---

On a directory backed by `wasmfs_create_node_backend()`, `chmod()` succeeds, and
`stat()` through WasmFS shows the new mode. But the file on the host keeps its
old mode. A later process (or this one, once WasmFS forgets the file) sees the
old mode. `utimensat()` behaves the same way. The legacy NODEFS and NODERAWFS
pass both through to the host (`fs.chmodSync`, `fs.utimesSync`).

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

**Test case** (`node_chmod.c`; `argv[1]` is an existing host directory):

```c
#include <emscripten/wasmfs.h>
#include <fcntl.h>
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>

int main(int argc, char **argv) {
  /* argv[1]: an existing host directory, mounted at /host. */
  wasmfs_create_directory("/host", 0777, wasmfs_create_node_backend(argv[1]));

  close(open("/host/file", O_CREAT | O_WRONLY | O_TRUNC, 0644));
  int r = chmod("/host/file", 0600);
  struct stat st;
  stat("/host/file", &st);
  printf("chmod(\"/host/file\", 0600) = %d; WasmFS now reports %03o\n", r,
         st.st_mode & 0777);
  return 0;
}
```

**Failing command line in full** (the same at `-O2`):

```
$ emcc -O0 -sWASMFS node_chmod.c -o node_chmod.js && mkdir host && node node_chmod.js "$PWD/host" && stat -c "host mode: %a" host/file
chmod("/host/file", 0600) = 0; WasmFS now reports 600
host mode: 644
```

Expected `host mode: 600`.

`utimensat()` (`node_utimes.c`, the same shape):

```c
#include <emscripten/wasmfs.h>
#include <fcntl.h>
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>

int main(int argc, char **argv) {
  wasmfs_create_directory("/host", 0777, wasmfs_create_node_backend(argv[1]));
  close(open("/host/file", O_CREAT | O_WRONLY | O_TRUNC, 0644));
  struct timespec ts[2] = {{.tv_sec = 1000000000}, {.tv_sec = 1000000000}};
  int r = utimensat(AT_FDCWD, "/host/file", ts, 0);
  struct stat st;
  stat("/host/file", &st);
  printf("utimensat = %d; WasmFS now reports mtime %lld\n", r, (long long)st.st_mtime);
  return 0;
}
```

```
$ emcc -O0 -sWASMFS node_utimes.c -o node_utimes.js && mkdir host && node node_utimes.js "$PWD/host" && stat -c "host mtime: %Y" host/file
utimensat = 0; WasmFS now reports mtime 1000000000
host mtime: 1790822725
```

<details>
<summary>Full compile and link output with <code>-v</code> appended (cache and scratch paths shortened)</summary>

```
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/clang -target wasm32-unknown-emscripten -fignore-exceptions -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr --sysroot=$EM_CACHE/sysroot -resource-dir=/nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter$EM_CACHE/sysroot/include -iwithsysroot/include/c++/v1 -Xclang -iwithsysroot/include/fakesdl -Xclang -iwithsysroot/include/compat -v -O0 -c node_chmod.c -o /tmp/emscripten_temp_matdsgwk/node_chmod.o
clang version 22.1.8
Target: wasm32-unknown-emscripten
Thread model: posix
InstalledDir: /nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin
 (in-process)
 "/nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin/clang-22" -cc1 -triple wasm32-unknown-emscripten -O0 -emit-obj -disable-free -clear-ast-before-backend -disable-llvm-verifier -discard-value-names -main-file-name node_chmod.c -mrelocation-model static -mframe-pointer=none -ffp-contract=on -fno-rounding-math -mconstructor-aliases -target-cpu generic -fvisibility=hidden -debugger-tuning=gdb -fdebug-compilation-dir=. -v -fcoverage-compilation-dir=. -resource-dir /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter $EM_CACHE/sysroot/include -iwithsysroot /include/c++/v1 -isysroot $EM_CACHE/sysroot -internal-isystem /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/include -internal-isystem $EM_CACHE/sysroot/include/wasm32-emscripten -internal-isystem $EM_CACHE/sysroot/include -ferror-limit 19 -fgnuc-version=4.2.1 -fskip-odr-check-in-gmf -fignore-exceptions -iwithsysroot/include/fakesdl -iwithsysroot/include/compat -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr -o /tmp/emscripten_temp_matdsgwk/node_chmod.o -x c node_chmod.c
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
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/wasm-ld -o node_chmod.wasm /tmp/tmp3y88kxdnlibemscripten_js_symbols.so -Bstatic --strip-debug --export=emscripten_stack_get_end --export=emscripten_stack_get_free --export=emscripten_stack_get_base --export=emscripten_stack_get_current --export=emscripten_stack_init --export=wasmfs_flush --export=_emscripten_stack_alloc --export=__wasm_call_ctors --export=_emscripten_stack_restore --export-if-defined=__start_em_asm --export-if-defined=__stop_em_asm --export-if-defined=__start_em_lib_deps --export-if-defined=__stop_em_lib_deps --export-if-defined=__start_em_js --export-if-defined=__stop_em_js --export-if-defined=main --export-if-defined=__main_argc_argv --export-if-defined=fflush --export-table -z stack-size=65536 --no-growable-memory --initial-heap=16777216 --no-entry --stack-first --table-base=1 /tmp/emscripten_temp_matdsgwk/node_chmod.o -L$EM_CACHE/sysroot/lib/wasm32-emscripten -L/nix/store/03iyrnrsxnbc64y6r62irmlbnbap5ya2-emscripten-6.0.9/share/emscripten/src/lib -lGL-getprocaddr -lal -lhtml5 -lstubs-debug -lnoexit -lc-debug -ldlmalloc-debug -lclang_rt.builtins -lc++-debug-noexcept -lc++abi-debug-noexcept -lsockets -lwasmfs_no_fs -lwasmfs-debug -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/llvm-objcopy node_chmod.wasm node_chmod.wasm '--remove-section=llvm.func_attr.annotate.*' --remove-section=producers --remove-section=name '--remove-section=.debug*'
```

</details>

**Where:**

- `chmod`/`fchmod` only call `File::Handle::setMode`, which updates the
  in-memory `mode`
  ([syscalls.cpp#L1188-L1217](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/syscalls.cpp#L1188-L1217),
  [file.h#L312-L316](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/file.h#L312-L316)).
- `utimensat` likewise sets only the in-memory times.
- There is no backend hook for metadata changes, so `NodeFile` and
  `NodeDirectory` never hear about them. The Node backend reads the mode from
  the host once, when it first looks the file up
  ([node_backend.cpp#L191](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/backends/node_backend.cpp#L191)).

**Suggested fix:** give `File` virtual `setMode` and `setTimes` hooks that
backends can override and that may fail; the default keeps today's
behaviour. `File::Handle::setMode` and a new `setTimes` call the hook first
and change WasmFS's record only once the backend has accepted the change,
and `chmod`, `fchmod` and `utimensat` return its error. The Node backend
implements the hooks with `fs.(f)chmodSync` and `fs.(f)utimesSync`,
through the open descriptor when there is one (so a file whose path has
been unlinked still works). Node can't leave one of the two times alone,
so an omitted time (`UTIME_OMIT`) is read back from the host and set again.
The new imports get their `libsigs.js` signatures.

```diff
--- a/src/lib/libsigs.js
+++ b/src/lib/libsigs.js
@@ -419,10 +419,13 @@
   _wasmfs_jsimpl_read__sig: 'ippppj',
   _wasmfs_jsimpl_set_size__sig: 'ippj',
   _wasmfs_jsimpl_write__sig: 'ippppj',
+  _wasmfs_node_chmod__sig: 'ipi',
   _wasmfs_node_close__sig: 'ii',
+  _wasmfs_node_fchmod__sig: 'iii',
   _wasmfs_node_fstat_size__sig: 'iip',
   _wasmfs_node_fsync__sig: 'ii',
   _wasmfs_node_ftruncate__sig: 'iij',
+  _wasmfs_node_futimes__sig: 'iidd',
   _wasmfs_node_get_mode__sig: 'ipp',
   _wasmfs_node_insert_directory__sig: 'ipi',
   _wasmfs_node_insert_file__sig: 'ipi',
@@ -436,6 +439,7 @@
   _wasmfs_node_symlink__sig: 'ipp',
   _wasmfs_node_truncate__sig: 'ipj',
   _wasmfs_node_unlink__sig: 'ip',
+  _wasmfs_node_utimes__sig: 'ipdd',
   _wasmfs_node_write__sig: 'iipiip',
   _wasmfs_opfs_close_access__sig: 'vpip',
   _wasmfs_opfs_close_blob__sig: 'vi',
--- a/src/lib/libwasmfs_node.js
+++ b/src/lib/libwasmfs_node.js
@@ -157,6 +157,36 @@
     });
   },

+  _wasmfs_node_chmod__deps: ['$wasmfsTry'],
+  _wasmfs_node_chmod: (path_p, mode) =>
+    wasmfsTry(() => fs.chmodSync(UTF8ToString(path_p), mode)),
+
+  _wasmfs_node_fchmod__deps: ['$wasmfsTry'],
+  _wasmfs_node_fchmod: (fd, mode) => wasmfsTry(() => fs.fchmodSync(fd, mode)),
+
+  // `target` is a path for `fs.utimesSync` or an fd for `fs.futimesSync`, and
+  // `stat` the matching stat function. Node can't leave one of the times
+  // alone, so an omitted time (Infinity) is read back from the file and set
+  // again, which preserves it to within a microsecond or so.
+  $wasmfsNodeUtimes__deps: ['$wasmfsTry'],
+  $wasmfsNodeUtimes: (utimes, stat, target, atime, mtime) => wasmfsTry(() => {
+    if (atime === Infinity || mtime === Infinity) {
+      const st = stat(target);
+      if (atime === Infinity) atime = st.atimeMs;
+      if (mtime === Infinity) mtime = st.mtimeMs;
+    }
+    // Numbers are taken as seconds, and keep the sub-millisecond part.
+    utimes(target, atime / 1000, mtime / 1000);
+  }),
+
+  _wasmfs_node_utimes__deps: ['$wasmfsNodeUtimes'],
+  _wasmfs_node_utimes: (path_p, atime, mtime) =>
+    wasmfsNodeUtimes(fs.utimesSync, fs.statSync, UTF8ToString(path_p), atime, mtime),
+
+  _wasmfs_node_futimes__deps: ['$wasmfsNodeUtimes'],
+  _wasmfs_node_futimes: (fd, atime, mtime) =>
+    wasmfsNodeUtimes(fs.futimesSync, fs.fstatSync, fd, atime, mtime),
+
   _wasmfs_node_truncate__i53abi: true,
   _wasmfs_node_truncate__deps: ['$wasmfsTry'],
   _wasmfs_node_truncate: (path_p, len) => {
--- a/system/lib/wasmfs/backends/node_backend.cpp
+++ b/system/lib/wasmfs/backends/node_backend.cpp
@@ -116,6 +116,18 @@
     }
     return ret;
   }
+
+  // Metadata changes go through the fd while there is one, so they still reach
+  // an open file after its path has been unlinked.
+  int setMode(mode_t mode) {
+    return -(isOpen() ? _wasmfs_node_fchmod(fd, mode)
+                      : _wasmfs_node_chmod(path.c_str(), mode));
+  }
+
+  int setTimes(double atime, double mtime) {
+    return -(isOpen() ? _wasmfs_node_futimes(fd, atime, mtime)
+                      : _wasmfs_node_utimes(path.c_str(), atime, mtime));
+  }
 };

 class NodeFile : public DataFile {
@@ -152,6 +164,12 @@
     return -_wasmfs_node_truncate(state.path.c_str(), size);
   }

+  int setMode(mode_t mode) override { return state.setMode(mode); }
+
+  int setTimes(double atime, double mtime) override {
+    return state.setTimes(atime, mtime);
+  }
+
   int open(oflags_t flags) override { return state.open(flags); }

   int close() override { return state.close(); }
@@ -200,6 +218,12 @@
     : Directory(mode, backend), state(path) {}

 private:
+  int setMode(mode_t mode) override { return state.setMode(mode); }
+
+  int setTimes(double atime, double mtime) override {
+    return state.setTimes(atime, mtime);
+  }
+
   std::string getChildPath(const std::string& name) {
     return state.path + '/' + name;
   }
--- a/system/lib/wasmfs/backends/node_backend.h
+++ b/system/lib/wasmfs/backends/node_backend.h
@@ -30,6 +30,13 @@
 int _wasmfs_node_unlink(const char* path);
 int _wasmfs_node_rmdir(const char* path);

+// Change the mode, or the access and modification times (in ms; INFINITY
+// leaves that time unchanged), and return 0 or an error code.
+int _wasmfs_node_chmod(const char* path, mode_t mode);
+int _wasmfs_node_fchmod(int fd, mode_t mode);
+int _wasmfs_node_utimes(const char* path, double atime, double mtime);
+int _wasmfs_node_futimes(int fd, double atime, double mtime);
+
 int _wasmfs_node_truncate(const char* path, off_t len);
 int _wasmfs_node_ftruncate(int fd, off_t len);

--- a/system/lib/wasmfs/file.h
+++ b/system/lib/wasmfs/file.h
@@ -9,6 +9,7 @@

 #include "support.h"
 #include <assert.h>
+#include <cmath>
 #include <emscripten.h>
 #include <emscripten/html5.h>
 #include <map>
@@ -106,6 +107,17 @@
   // called on files that have not been opened.
   virtual off_t getSize() = 0;

+  // Apply new permission bits to the underlying file, for backends that store
+  // them. Returns 0 on success or a negative error code. May be called on files
+  // that have not been opened.
+  virtual int setMode(mode_t mode) { return 0; }
+
+  // Set the underlying file's access and modification times, in ms, for
+  // backends that store them. INFINITY leaves that time unchanged. Returns 0 on
+  // success or a negative error code. May be called on files that have not been
+  // opened.
+  virtual int setTimes(double atime, double mtime) { return 0; }
+
   mode_t mode = 0; // User and group mode bits for access permission.

   double atime; // Time when the content was last accessed, in ms.
@@ -341,10 +353,15 @@
     : lock(file->mutex, std::defer_lock), file(file) {}
   off_t getSize() { return file->getSize(); }
   mode_t getMode() { return file->mode; }
-  void setMode(mode_t mode) {
+  [[nodiscard]] int setMode(mode_t mode) {
     // The type bits can never be changed (whether something is a file or a
     // directory, for example).
-    file->mode = (file->mode & S_IFMT) | (mode & ~S_IFMT);
+    mode &= ~S_IFMT;
+    if (auto err = file->setMode(mode)) {
+      return err;
+    }
+    file->mode = (file->mode & S_IFMT) | mode;
+    return 0;
   }
   double getCTime() {
     return file->ctime;
@@ -370,6 +387,23 @@
   void updateATime() {
     file->atime = emscripten_date_now();
   }
+  // Set the access and modification times, in ms. INFINITY leaves that time
+  // unchanged.
+  [[nodiscard]] int setTimes(double atime, double mtime) {
+    if (atime == INFINITY && mtime == INFINITY) {
+      return 0;
+    }
+    if (auto err = file->setTimes(atime, mtime)) {
+      return err;
+    }
+    if (atime != INFINITY) {
+      file->atime = atime;
+    }
+    if (mtime != INFINITY) {
+      file->mtime = mtime;
+    }
+    return 0;
+  }

   // Note: parent.lock() creates a new shared_ptr to the same Directory
   // specified by the parent weak_ptr.
--- a/system/lib/wasmfs/syscalls.cpp
+++ b/system/lib/wasmfs/syscalls.cpp
@@ -1177,15 +1177,7 @@
     mTime = timespec_to_ms(times[1]);
   }

-  auto locked = parsed.getFile()->locked();
-  if (aTime != INFINITY) {
-    locked.setATime(aTime);
-  }
-  if (mTime != INFINITY) {
-    locked.setMTime(mTime);
-  }
-
-  return 0;
+  return parsed.getFile()->locked().setTimes(aTime, mTime);
 }

 // TODO: Test this with non-AT_FDCWD values.
@@ -1199,7 +1191,9 @@
     return err;
   }
   auto lockedFile = parsed.getFile()->locked();
-  lockedFile.setMode(mode);
+  if (auto err = lockedFile.setMode(mode)) {
+    return err;
+  }
   // On POSIX, ctime is updated on metadata changes, like chmod.
   lockedFile.updateCTime();
   return 0;
@@ -1215,7 +1209,9 @@
     return -EBADF;
   }
   auto lockedFile = openFile->locked().getFile()->locked();
-  lockedFile.setMode(mode);
+  if (auto err = lockedFile.setMode(mode)) {
+    return err;
+  }
   lockedFile.updateCTime();
   return 0;
 }
```

A separate one-line fix turned up on the way: musl's `futimens()` calls
`utimensat(fd, NULL, …)`, and `__syscall_utimensat` builds a
`std::string_view` from that null path, which libc++'s hardening assertions
reject (`-O0`), so `futimens()` never worked under WasmFS with assertions.
It deserves its own PR:

```diff
--- a/system/lib/wasmfs/syscalls.cpp
+++ b/system/lib/wasmfs/syscalls.cpp
@@ -1156,13 +1156,14 @@
   }

   // Add AT_EMPTY_PATH as Linux (and so, musl, and us) has a nonstandard
-  // behavior in which an empty path means to operate on whatever is in dirFD
-  // (directory or not), which is exactly the behavior of AT_EMPTY_PATH (but
-  // without passing that in). See "C library/kernel ABI differences" in
-  // https://man7.org/linux/man-pages/man2/utimensat.2.html
+  // behavior in which a null path (which futimens passes) means to operate on
+  // whatever is in dirFD (directory or not), which is exactly the behavior of
+  // AT_EMPTY_PATH (but without passing that in). See "C library/kernel ABI
+  // differences" in https://man7.org/linux/man-pages/man2/utimensat.2.html
   //
   // TODO: Handle AT_SYMLINK_NOFOLLOW once we traverse symlinks correctly.
-  auto parsed = path::getFileAt(dirfd, path, flags | AT_EMPTY_PATH);
+  auto parsed =
+    path::getFileAt(dirfd, path ? path : "", flags | AT_EMPTY_PATH);
   if (auto err = parsed.getError()) {
     return err;
   }
```

With both applied to 6.0.9 (and the other WasmFS fixes reported
separately), the test cases print, at `-O0` and `-O2`:

```
chmod("/host/file", 0600) = 0; WasmFS now reports 600
host mode: 600
utimensat = 0; WasmFS now reports mtime 1000000000
host mtime: 1000000000
```

They were also tested with `fchmod` and `futimens` on open files, on
directories, with each of `UTIME_OMIT` and `UTIME_NOW`, and with host
errors (`EPERM` on a root-owned file, `EROFS` on a read-only mount), which
now come back to the caller with WasmFS's record unchanged. Emscripten's
own WasmFS tests (a 96-test selection) give the same results as without
it, and `other.test_gen_sig_info` passes.

---

## Evidence

- **FAQ and docs.** The FAQ doesn't cover the WasmFS Node backend. The File
  System API page says WasmFS is "not yet feature-complete with the old FS",
  which arguably covers this. But nothing documents that metadata changes stay
  in memory, and NODEFS/NODERAWFS do pass them through. So this reads as a
  missing feature worth an issue, not a bug report against documented
  behaviour. Run at `-O0` and `-O2`, with the same result.
- **bug_reports.rst.** The source, `emcc -v`, the symptoms and a tested fix
  are included. It adds to the backend interface, which the maintainers may
  want to shape differently; symlinks themselves aren't covered.
- **Limitations.** `UTIME_NOW` is sent as an explicit time, so on a file the
  user can write but doesn't own the host refuses with `EPERM`, as legacy
  NODEFS does. Carry it with the `open`/`close` fix: without it a failed
  open yields fd 2 and `fchmod` would reach the host's real stderr.
- **Duplicate search.** "wasmfs chmod", "wasmfs node chmod", "chmod node host",
  "chmod not persisted", "NODEFS chmod", "wasmfs node mode", "wasmfs node
  backend", "wasmfs_create_node_backend", "node_backend.cpp" and "chmod", plus a
  scan of all open "wasmfs" issues, turned up #15967 ("WasmFS: `chmod`",
  closed, the original implementation), #19427 (JS API `chmod`), #15335 and
  #14866 (JS FS). None is this bug. #19417 and #24830 discuss rebuilding
  NODERAWFS outside WasmFS. A maintainer noted there that WasmFS "caches a
  bunch of information … and assumes that it has complete control over the
  file system". These reproductions change files only through WasmFS, so that
  caveat doesn't apply, but expect it to come up.
- **Why it matters to us.** Under Node, GLib's `/fileutils/stdio-wrappers` hit
  this: `chmod(0777)` on a Node-backed directory never reached the host, and
  the next `g_creat()` there failed. With the fix it runs as upstream has it,
  and GLib's tests keep their temporary files on the host.
  `modules/toolchain/node-host-fs.c` no longer `chmod`s the WasmFS root to
  the host's mode.
- **Tip-of-tree.** Checked read-only through the GitHub API on 2026-09-30:
  `node_backend.cpp` and `file.h` are unchanged between 6.0.9 and `main`
  (2151200, 139 commits later). `syscalls.cpp` changed only in `fdatasync`'s
  error sign (#27806) and `utimensat`'s timestamp rounding; the cited code is
  unchanged, a few lines further down. The latest release, 6.0.10 (tagged
  2026-09-18), matches. The conclusion comes from the diff; `main` wasn't
  rebuilt. Our build is nixpkgs' 6.0.9 with LLVM 22.1.8.
- ibus-web carries this fix as `modules/emscripten/patches/0013-wasmfs-node-chmod.patch`, and the `futimens` fix as `modules/emscripten/patches/0008-wasmfs-futimens-null-path.patch`.
