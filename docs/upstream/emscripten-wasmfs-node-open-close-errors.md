# WasmFS Node backend: a failed host `open` becomes a file descriptor; `close` errors trip an assertion

**Draft: new issue.** No existing issue covers it. #26598 (merged) fixed the
same sign mix-up for `insertMove`.

## Issue title

WasmFS Node backend: host open() errors are used as file descriptors, and close() errors are returned with the wrong sign

## Issue body

---

The Node backend's JS helpers report errors as **positive** errno values
(`wasmfsTry`). Two callers in `node_backend.cpp` expect something else:

1. `NodeState::open` treats any non-negative result of `_wasmfs_node_open` as a
   host file descriptor. A failed host open returns the errno, which is
   positive, so it is taken for a descriptor and `open()` succeeds. `EACCES`
   (2) becomes fd 2, Node's stderr. `ENOENT` (44) becomes fd 44, usually
   unopened.
2. `NodeState::close` returns `_wasmfs_node_close`'s positive errno as is.
   `__wasi_fd_close` negates it and asserts the result is `>= 0`.

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

**Test case 1** (`node_open_error.c`): opening a root-owned, mode-0644 file for
writing, as a normal user:

```c
#include <emscripten/wasmfs.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(void) {
  /* Run as a non-root user: /etc/passwd is root-owned, mode 0644. */
  wasmfs_create_directory("/etc", 0777, wasmfs_create_node_backend("/etc"));

  errno = 0;
  int fd = open("/etc/passwd", O_WRONLY);
  printf("open(\"/etc/passwd\", O_WRONLY) = %d (%s)\n", fd,
         fd < 0 ? strerror(errno) : "no error");
  fflush(stdout);
  if (fd >= 0) {
    ssize_t n = write(fd, "written to /etc/passwd?\n", 24);
    printf("write = %zd\n", n);
    fflush(stdout);
    errno = 0;
    int r = close(fd);
    printf("close = %d (%s)\n", r, r < 0 ? strerror(errno) : "no error");
  }
  return 0;
}
```

**Failing command line in full** (the same at `-O2`):

```
$ emcc -O0 -sWASMFS node_open_error.c -o node_open_error.js && id -u && node node_open_error.js 2> stderr.txt; echo "--- stderr:"; cat stderr.txt
1000
open("/etc/passwd", O_WRONLY) = 3 (no error)
write = 24
close = 0 (no error)
--- stderr:
written to /etc/passwd?
```

The host's `EACCES` (2) is taken for fd 2. `open()` succeeds, the write lands
on stderr, and `close()` closes Node's own stderr. Expected:
`open("/etc/passwd", O_WRONLY) = -1 (Permission denied)`.

WasmFS's own permission check passes here: it accepts any write bit (`0222`) and
ignores ownership. The host refuses because the caller doesn't own the file.

**Test case 2** (`node_close_errno.c`): a host `open` that fails with `ENOENT`.
The easiest way to get one is the stale path a `rename` leaves behind (#NNNN):

```c
#include <emscripten/wasmfs.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
  /* argv[1]: an existing host directory, mounted at /host. */
  wasmfs_create_directory("/host", 0777, wasmfs_create_node_backend(argv[1]));

  close(open("/host/a", O_CREAT | O_WRONLY | O_TRUNC, 0644));
  rename("/host/a", "/host/b");

  /* The host open fails with ENOENT (see the rename issue). */
  errno = 0;
  int fd = open("/host/b", O_RDONLY);
  printf("open = %d (%s)\n", fd, fd < 0 ? strerror(errno) : "no error");
  char buf[8];
  errno = 0;
  ssize_t n = read(fd, buf, sizeof buf);
  printf("read = %zd (%s)\n", n, n < 0 ? strerror(errno) : "no error");
  fflush(stdout);
  errno = 0;
  int r = close(fd);
  printf("close = %d (%s)\n", r, r < 0 ? strerror(errno) : "no error");
  return 0;
}
```

```
$ emcc -O0 -sWASMFS node_close_errno.c -o node_close_errno.js && mkdir host && node node_close_errno.js "$PWD/host"
open = 3 (no error)
read = -1 (Bad file descriptor)
Aborted(Assertion failed: ret >= 0, at: /emsdk/emscripten/system/lib/wasmfs/syscalls.cpp,305,__wasi_fd_close)
node_close_errno.js:584
  var e = new WebAssembly.RuntimeError(what);
          ^

RuntimeError: Aborted(Assertion failed: ret >= 0, at: /emsdk/emscripten/system/lib/wasmfs/syscalls.cpp,305,__wasi_fd_close)
    at abort (node_close_errno.js:584:11)
    at ___assert_fail (node_close_errno.js:904:7)
    at wasm://wasm/00069496:wasm-function[374]:0x120a4
    at wasm://wasm/00069496:wasm-function[37]:0xb7f
    at wasm://wasm/00069496:wasm-function[34]:0xaf5
    at node_close_errno.js:615:12
    at callMain (node_close_errno.js:2051:15)
    at run (node_close_errno.js:2097:22)
    at node_close_errno.js:2137:25

Node.js v24.20.0
[exit status 1]
```

At `-O2` the assertion is compiled out. `__wasi_fd_close` then returns -8 as a
`uint16_t` `__wasi_errno_t`, so `close()` fails with errno 65528, which prints
as "Unknown error":

```
$ emcc -O2 -sWASMFS node_close_errno.c -o node_close_errno.js && mkdir host && node node_close_errno.js "$PWD/host"
open = 3 (no error)
read = -1 (Bad file descriptor)
close = -1 (Unknown error)
```

<details>
<summary>Full compile and link output with <code>-v</code> appended (cache and scratch paths shortened)</summary>

```
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/clang -target wasm32-unknown-emscripten -fignore-exceptions -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr --sysroot=$EM_CACHE/sysroot -resource-dir=/nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter$EM_CACHE/sysroot/include -iwithsysroot/include/c++/v1 -Xclang -iwithsysroot/include/fakesdl -Xclang -iwithsysroot/include/compat -v -O0 -c node_open_error.c -o /tmp/emscripten_temp_vt3o98bv/node_open_error.o
clang version 22.1.8
Target: wasm32-unknown-emscripten
Thread model: posix
InstalledDir: /nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin
 (in-process)
 "/nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin/clang-22" -cc1 -triple wasm32-unknown-emscripten -O0 -emit-obj -disable-free -clear-ast-before-backend -disable-llvm-verifier -discard-value-names -main-file-name node_open_error.c -mrelocation-model static -mframe-pointer=none -ffp-contract=on -fno-rounding-math -mconstructor-aliases -target-cpu generic -fvisibility=hidden -debugger-tuning=gdb -fdebug-compilation-dir=. -v -fcoverage-compilation-dir=. -resource-dir /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter $EM_CACHE/sysroot/include -iwithsysroot /include/c++/v1 -isysroot $EM_CACHE/sysroot -internal-isystem /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/include -internal-isystem $EM_CACHE/sysroot/include/wasm32-emscripten -internal-isystem $EM_CACHE/sysroot/include -ferror-limit 19 -fgnuc-version=4.2.1 -fskip-odr-check-in-gmf -fignore-exceptions -iwithsysroot/include/fakesdl -iwithsysroot/include/compat -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr -o /tmp/emscripten_temp_vt3o98bv/node_open_error.o -x c node_open_error.c
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
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/wasm-ld -o node_open_error.wasm /tmp/tmpg_gwm8lolibemscripten_js_symbols.so -Bstatic --strip-debug --export=emscripten_stack_get_end --export=emscripten_stack_get_free --export=emscripten_stack_get_base --export=emscripten_stack_get_current --export=emscripten_stack_init --export=wasmfs_flush --export=_emscripten_stack_alloc --export=__wasm_call_ctors --export=_emscripten_stack_restore --export-if-defined=__start_em_asm --export-if-defined=__stop_em_asm --export-if-defined=__start_em_lib_deps --export-if-defined=__stop_em_lib_deps --export-if-defined=__start_em_js --export-if-defined=__stop_em_js --export-if-defined=main --export-if-defined=__main_argc_argv --export-if-defined=fflush --export-table -z stack-size=65536 --no-growable-memory --initial-heap=16777216 --no-entry --stack-first --table-base=1 /tmp/emscripten_temp_vt3o98bv/node_open_error.o -L$EM_CACHE/sysroot/lib/wasm32-emscripten -L/nix/store/03iyrnrsxnbc64y6r62irmlbnbap5ya2-emscripten-6.0.9/share/emscripten/src/lib -lGL-getprocaddr -lal -lhtml5 -lstubs-debug -lnoexit -lc-debug -ldlmalloc-debug -lclang_rt.builtins -lc++-debug-noexcept -lc++abi-debug-noexcept -lsockets -lwasmfs_no_fs -lwasmfs-debug -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/llvm-objcopy node_open_error.wasm node_open_error.wasm '--remove-section=llvm.func_attr.annotate.*' --remove-section=producers --remove-section=name '--remove-section=.debug*'
```

</details>

**Where:**
- `wasmfsTry` returns `ERRNO_CODES[code]`, which is positive
  ([libwasmfs_node.js#L19-L27](https://github.com/emscripten-core/emscripten/blob/6.0.9/src/lib/libwasmfs_node.js#L19-L27)).
- `_wasmfs_node_open` returns either an fd or that errno
  ([#L170-L173](https://github.com/emscripten-core/emscripten/blob/6.0.9/src/lib/libwasmfs_node.js#L170-L173)).
- `NodeState::open` checks `result < 0`
  ([node_backend.cpp#L61](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/backends/node_backend.cpp#L61),
  [#L72](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/backends/node_backend.cpp#L72)).
- `NodeState::close` returns the positive errno
  ([#L93](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/backends/node_backend.cpp#L93)).
- `__wasi_fd_close` asserts on it
  ([syscalls.cpp#L304-L305](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/syscalls.cpp#L304-L305)).

**Suggested fix:** an fd and an errno can't share the positive range, so
`_wasmfs_node_open` returns a negated errno. `close` negates its helper's
result like the other callers do.

Reporting a failed `open` uncovers a second bug that the bogus descriptor
hid. `insertDataFile` creates the file with `'ax'` and closes it, then the
`open()` that follows reopens it by path, where the new file's own mode can
refuse it: `open(path, O_CREAT | O_RDONLY, 0)` gets `EACCES`, though POSIX
lets the creating open through whatever the mode. Fixed alone, the sign
change makes `wasmfs.test_fcntl_open_nodefs`, `wasmfs.test_fcntl_open_rawfs`
and `other.test_wasmfs_getdents_node` fail on that. So the file is created
with `'wx+'`, read-write, and that descriptor is kept for the first open
(closed with the file if nothing opens it). That also drops `'a'`, which
would make every `pwrite` to the descriptor append on Linux.

```diff
--- a/src/lib/libwasmfs_node.js
+++ b/src/lib/libwasmfs_node.js
@@ -121,12 +121,16 @@
     // implicitly return 0
   },
 
-  _wasmfs_node_insert_file__deps: ['$wasmfsTry'],
+  _wasmfs_node_insert_file__deps: ['$wasmfsNodeConvertNodeCode'],
   _wasmfs_node_insert_file: (path_p, mode) => {
-    return wasmfsTry(() => {
-      fs.closeSync(fs.openSync(UTF8ToString(path_p), 'ax', mode));
-      // implicitly return 0
-    });
+    // A file descriptor open for reading and writing, whatever `mode` allows,
+    // or a negated errno.
+    try {
+      return fs.openSync(UTF8ToString(path_p), 'wx+', mode);
+    } catch (e) {
+      if (!e.code) throw e;
+      return -wasmfsNodeConvertNodeCode(e);
+    }
   },
 
   _wasmfs_node_insert_directory__deps: ['$wasmfsTry'],
@@ -167,9 +171,15 @@
     return wasmfsTry(() => fs.ftruncateSync(fd, len));
   },
 
-  _wasmfs_node_open__deps: ['$wasmfsTry'],
+  _wasmfs_node_open__deps: ['$wasmfsNodeConvertNodeCode'],
   _wasmfs_node_open: (path_p, mode_p) => {
-    return wasmfsTry(() => fs.openSync(UTF8ToString(path_p), UTF8ToString(mode_p)));
+    // A file descriptor on success, a negated errno on failure.
+    try {
+      return fs.openSync(UTF8ToString(path_p), UTF8ToString(mode_p));
+    } catch (e) {
+      if (!e.code) throw e;
+      return -wasmfsNodeConvertNodeCode(e);
+    }
   },
 
   _wasmfs_node_rename__deps: ['$wasmfsTry'],
--- a/system/lib/wasmfs/backends/node_backend.cpp
+++ b/system/lib/wasmfs/backends/node_backend.cpp
@@ -21,6 +21,8 @@
   size_t openCount = 0;
   oflags_t openFlags = 0;
   int fd = -1;
+  // The descriptor that created the file, until its first open takes it.
+  int created = -1;
 
 public:
   std::string path;
@@ -34,10 +36,29 @@
 
   bool isOpen() { return openCount > 0; }
 
+  // Keep the read-write descriptor that created the file for the open that
+  // follows: the file's mode doesn't bind the open that creates it, but would
+  // refuse a second one.
+  void keepCreated(int createdFD) { created = createdFD; }
+
+  void closeCreated() {
+    if (created >= 0) {
+      (void)_wasmfs_node_close(created);
+      created = -1;
+    }
+  }
+
   // Attempt to open the file with the given flags, returning 0 on success or an
   // error code.
   int open(oflags_t flags) {
     int result = 0;
+    if (openCount == 0 && created >= 0) {
+      fd = created;
+      created = -1;
+      openFlags = O_RDWR;
+      ++openCount;
+      return 0;
+    }
     if (openCount == 0) {
       // No existing fd, so open a fresh one.
       switch (flags) {
@@ -90,7 +111,7 @@
   int close() {
     int ret = 0;
     if (--openCount == 0) {
-      ret = _wasmfs_node_close(fd);
+      ret = -_wasmfs_node_close(fd);
       *this = NodeState(path);
     }
     return ret;
@@ -104,6 +125,8 @@
   NodeFile(mode_t mode, backend_t backend, std::string path)
     : DataFile(mode, backend), state(path) {}
 
+  ~NodeFile() { state.closeCreated(); }
+
 private:
   off_t getSize() override {
     // TODO: This should really be using a 64-bit file size type.
@@ -220,10 +243,13 @@
   std::shared_ptr<DataFile> insertDataFile(const std::string& name,
                                            mode_t mode) override {
     auto childPath = getChildPath(name);
-    if (_wasmfs_node_insert_file(childPath.c_str(), mode)) {
+    int fd = _wasmfs_node_insert_file(childPath.c_str(), mode);
+    if (fd < 0) {
       return nullptr;
     }
-    return std::make_shared<NodeFile>(mode, getBackend(), childPath);
+    auto file = std::make_shared<NodeFile>(mode, getBackend(), childPath);
+    file->state.keepCreated(fd);
+    return file;
   }
 
   std::shared_ptr<Directory> insertDirectory(const std::string& name,
--- a/system/lib/wasmfs/backends/node_backend.h
+++ b/system/lib/wasmfs/backends/node_backend.h
@@ -19,8 +19,11 @@
 int _wasmfs_node_stat_size(const char* path, uint32_t* size);
 int _wasmfs_node_fstat_size(int fd, uint32_t* size);
 
-// Create a new file system entry and return 0 or an error code.
-int _wasmfs_node_insert_file(const char* path, mode_t mode);
+// Create a new file and return a file descriptor open for reading and
+// writing, or a negative error code.
+[[nodiscard]] int _wasmfs_node_insert_file(const char* path, mode_t mode);
+
+// Create a new directory and return 0 or an error code.
 int _wasmfs_node_insert_directory(const char* path, mode_t mode);
 
 // Unlink the given file and return 0 or an error code.
```

With this applied to 6.0.9, test case 1 prints:

```
open("/etc/passwd", O_WRONLY) = -1 (Permission denied)
--- stderr:
```

The header comment on `_wasmfs_node_open` in `node_backend.h` ("Open the file
and return the underlying file descriptor") could say so too.

---

## Notes for the user

- **Fill in #NNNN.** It is the issue number of
  `emscripten-wasmfs-node-rename.md` once that's posted. Or reword "(#NNNN)" to
  "(reported separately)".
- **Test case 1 needs a non-root user** and a root-owned, mode-0644
  `/etc/passwd`, which is true on ordinary Linux systems. It doesn't write to
  `/etc/passwd`: the write goes to stderr, which is the bug. It does close the
  Node process's real fd 2, which is harmless at the end of the program.
- **The `close` half wasn't exercised.** The fixed tree also has the `rename`
  fix, so test case 2's `open` reaches the right host file and succeeds. The
  fixed run printed open = 3, read = 0, close = 0. With no host
  error, `close` never sees one. The `close` change is by inspection: every
  other helper caller negates.
- **How the fix was tested.** The "with this applied" run used a 6.0.9 tree
  with all of this set's candidate fixes applied at once. With the
  creation change, the three tests above pass again, and a 96-test WasmFS
  selection (stat, chmod, utime, access, links, `fcntl_open`, readdir,
  `unistd_*`, `other.test_wasmfs_*`, ...) gives results identical to
  unpatched 6.0.9.
- **Latent, not fixed here:** `NodeState::open` maps `O_WRONLY` to `"r+"` (the
  TODO says so), so a write-only file (mode `0200`) can't be opened for
  writing once it exists. A fix would pass numeric flags to `fs.openSync`.
- **FAQ.** Nothing in the FAQ covers it. Run at `-O0` and `-O2`: the open
  mix-up shows the same at both, and the `close` assertion shows only at `-O0`.
- **bug_reports.rst.** The source, `emcc -v`, the symptoms and a tested fix are
  included. Bitcode is left out because the fault is in `libwasmfs`. A natural
  small PR, in the same spirit as #26598.
- **Duplicate search.** "wasmfs node fd_close assertion", "__wasi_fd_close
  assertion", "ret >= 0 fd_close", "insertMove", "node_backend.cpp" and
  "wasmfs node backend", plus a scan of all open "wasmfs" issues, turned up
  #26598 (merged: the same sign fix for `insertMove`, open/close untouched),
  #23618 ("WASMFS + NODERAWFS fails a bunch of test", closed) and #24830/#19417
  (WasmFS NODERAWFS design). None reports this.
- **Why it matters to us.** Every GLib test failure the plan blames on the
  `fd_close` assertion reaches it this way, after a `rename`.
- **Tip-of-tree.** Checked read-only through the GitHub API on 2026-09-30:
  `node_backend.cpp`, `node_backend.h` and `libwasmfs_node.js` are unchanged
  between 6.0.9 and `main` (2151200, 139 commits later). `syscalls.cpp` changed
  only in `fdatasync`'s error sign (#27806) and `utimensat`'s timestamp
  rounding; the cited code is unchanged, a few lines further down. The only sign
  fix since 6.0.9 is #27806, for `fdatasync`. The latest release, 6.0.10 (tagged
  2026-09-18), matches. The conclusion comes from the diff; `main` wasn't
  rebuilt. Our build is nixpkgs' 6.0.9 with LLVM 22.1.8.
- ibus-web carries this fix as `modules/emscripten/patches/wasmfs-node-open-close-errors.patch`.
