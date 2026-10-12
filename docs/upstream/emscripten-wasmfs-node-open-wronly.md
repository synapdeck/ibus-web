# WasmFS Node backend: `O_WRONLY` opens the host's file read-write, so a write-only (`0200`) file can't be opened

**Posted: don't post again.** Filed as [#27847](https://github.com/emscripten-core/emscripten/issues/27847) (2026-10-01,
no replies yet). It cites #27825, whose fix (0010) this one sits on. ibus-web carries the fix as 0023; it can follow as
a PR after 0010's.

Checked against `main` 0479680 (2026-10-12): `NodeState::open` still opens `O_WRONLY` as `"r+"`, with the TODO.

**As posted** (what #27847 says, kept for reference). When drafted, no existing issue covered it. It was found running
Emscripten's `test_stat_chmod`, which skips on WasmFS with the Node backend, un-skipped with #27825's fix applied.

## Issue title

[WasmFS] Node backend can't open a write-only (0200) file for writing

## Issue body

---

With WasmFS, the Node backend opens a file for `O_WRONLY` as if it were `O_RDWR`: `NodeState::open` passes `fs.openSync`
an fopen-style mode string, and since the only write-only strings (`"w"`, `"a"`) truncate or append, `O_WRONLY` uses
`"r+"`
([node_backend.cpp#L47-L56](https://github.com/emscripten-core/emscripten/blob/f9ce3a19e7d6b34d5c74cd71dd245962aab6f6f5/system/lib/wasmfs/backends/node_backend.cpp#L47-L56),
with a TODO). The host then refuses a file that may be written but not read, so a file with mode `0200` can't be opened
for writing at all. That includes the `open(O_CREAT | O_WRONLY, 0200)` that creates it, since the backend creates the
file and then opens it again.

Because of #27825, the host's `EACCES` is currently taken for a file descriptor, so the writes below land on the host's
stderr and the file stays empty. With #27825 fixed, the `open()` fails with `EACCES` instead. Either way the file can't
be written. (As root the host allows the open, so this only shows up for other users.)

**Version of emscripten/emsdk:**

```
emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 6.0.11-git (f9ce3a19e)
```

`main` at f9ce3a19e with the toolchain from `test/emsdk_version.txt` (c366a3c2), Node.js v24.19.0, x86_64 Linux, run as
a non-root user.

**Test case** (`writeonly.c`):

```c
#include <emscripten/wasmfs.h>
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>

int main() {
  wasmfs_create_directory("/host", 0777, wasmfs_create_node_backend("."));

  int fd = open("/host/file", O_CREAT | O_WRONLY | O_EXCL, 0200);
  printf("open(O_CREAT | O_WRONLY, 0200) = %d\n", fd);
  ssize_t n = write(fd, "abc", 3);
  printf("write = %zd\n", n);
  close(fd);

  fd = open("/host/file", O_WRONLY);
  printf("open(O_WRONLY) = %d\n", fd);
  return 0;
}
```

**Failing command line in full:**

```
$ emcc -sWASMFS writeonly.c -o writeonly.js
$ node writeonly.js 2>stderr.txt
open(O_CREAT | O_WRONLY, 0200) = 3
write = 3
open(O_WRONLY) = 3
$ cat stderr.txt
abc
$ stat -c '%s bytes' file
0 bytes
```

Expected: `write` puts `abc` in `file`, and the second `open()` succeeds, as on Linux. Passing numeric flags
(`fs.constants.O_WRONLY` and friends) to `fs.openSync` instead of a mode string would avoid the mapping problem; I have
a PR ready for that.

---

## The fix (for the PR)

`_wasmfs_node_open()` takes the access mode in place of a mode string and passes Node's own constant for it to
`fs.openSync()`; an open that needs more access than the file's shared host descriptor has still reopens it read-write.
The import's signature changes from `ipp` to `ipi`. The diff is against 6.0.9 with #27825's fix (0010) applied, whose
`NodeState::open()` keeps the descriptor that created a file for the first open, which is what lets the creating
`open()` above succeed:

```diff
--- a/src/lib/libsigs.js
+++ b/src/lib/libsigs.js
@@ -429,7 +429,7 @@ sigs = {
   _wasmfs_node_get_mode__sig: 'ipp',
   _wasmfs_node_insert_directory__sig: 'ipi',
   _wasmfs_node_insert_file__sig: 'ipi',
-  _wasmfs_node_open__sig: 'ipp',
+  _wasmfs_node_open__sig: 'ipi',
   _wasmfs_node_read__sig: 'iipiip',
   _wasmfs_node_readdir__sig: 'ipp',
   _wasmfs_node_readlink__sig: 'ippi',
--- a/src/lib/libwasmfs_node.js
+++ b/src/lib/libwasmfs_node.js
@@ -201,10 +201,15 @@ var wasmFSNodeLibrary = {
   },

   _wasmfs_node_open__deps: ['$wasmfsNodeConvertNodeCode'],
-  _wasmfs_node_open: (path_p, mode_p) => {
+  _wasmfs_node_open: (path_p, accessMode) => {
+    // Node's mode strings have no write-only open that neither truncates nor
+    // appends, so the host's own flags are passed instead.
+    var flags = accessMode == {{{ cDefs.O_WRONLY }}} ? fs.constants.O_WRONLY :
+                accessMode == {{{ cDefs.O_RDWR }}} ? fs.constants.O_RDWR :
+                fs.constants.O_RDONLY;
     // A file descriptor on success, a negated errno on failure.
     try {
-      return fs.openSync(UTF8ToString(path_p), UTF8ToString(mode_p));
+      return fs.openSync(UTF8ToString(path_p), flags);
     } catch (e) {
       if (!e.code) throw e;
       return -wasmfsNodeConvertNodeCode(e);
--- a/system/lib/wasmfs/backends/node_backend.cpp
+++ b/system/lib/wasmfs/backends/node_backend.cpp
@@ -63,18 +63,9 @@ public:
       // No existing fd, so open a fresh one.
       switch (flags) {
         case O_RDONLY:
-          result = _wasmfs_node_open(path.c_str(), "r");
-          break;
         case O_WRONLY:
-          // TODO(sbc): Specific handling of O_WRONLY.
-          // There is no simple way to map O_WRONLY to an fopen-style
-          // mode string since the only two modes that are write only
-          // are `w` and `a`.  The problem with the former is that it
-          // truncates to file.  The problem with the latter is that it
-          // opens for appending.  For now simply opening in O_RDWR
-          // mode is enough to pass all our tests.
         case O_RDWR:
-          result = _wasmfs_node_open(path.c_str(), "r+");
+          result = _wasmfs_node_open(path.c_str(), flags);
           break;
         default:
           WASMFS_UNREACHABLE("Unexpected open access mode");
@@ -89,7 +80,7 @@ public:
                 (flags == O_RDONLY || flags == O_RDWR))) {
       // We already have a file descriptor, but we need to replace it with a new
       // fd with more access.
-      result = _wasmfs_node_open(path.c_str(), "r+");
+      result = _wasmfs_node_open(path.c_str(), O_RDWR);
       if (result < 0) {
         return result;
       }
--- a/system/lib/wasmfs/backends/node_backend.h
+++ b/system/lib/wasmfs/backends/node_backend.h
@@ -46,8 +46,9 @@ int _wasmfs_node_symlink(const char *target, const char *linkpath);

 int _wasmfs_node_readlink(const char *path, const char *buf, int bufsize);

-// Open the file and return the underlying file descriptor.
-[[nodiscard]] int _wasmfs_node_open(const char* path, const char* mode);
+// Open the file with the given access mode (O_RDONLY, O_WRONLY or O_RDWR) and
+// return the underlying file descriptor.
+[[nodiscard]] int _wasmfs_node_open(const char* path, int accessMode);

 // Close the underlying file descriptor.
 [[nodiscard]] int _wasmfs_node_close(int fd);
```

With it and 0010 on 6.0.9, as a non-root user, at `-O0` and `-O2`:

```
$ node writeonly.js
open(O_CREAT | O_WRONLY, 0200) = 3
write = 3
open(O_WRONLY) = 3
$ stat -c '%s bytes' file
3 bytes
```

A later `open(O_RDONLY)` or `open(O_RDWR)` of the file fails with `EACCES`, as on Linux.

## Evidence

- **Test needs a non-root user.** Root opens the file read-write whatever its mode.
- **How the fix was tested.** On 6.0.9 with ibus-web's whole patch stack, the issue's test case and `wronly.c` (create,
  write, reopen with `O_WRONLY | O_APPEND` and write again, then `O_RDONLY` and `O_RDWR`) give the same results as
  native Linux. `checks.emscripten-fixes` (`Patch0023.OpenWriteOnlyFile`) makes a file write-only through WasmFS and
  writes it through an `O_WRONLY` open.
- **`test_stat_chmod`.** Emscripten's own test skips on WasmFS with the Node backend. Un-skipped, it fails at its
  write-only `open(O_WRONLY)` without the fix; with it, it gets further and stops at `fchmodat(AT_SYMLINK_NOFOLLOW)` of
  a symlink, which it expects to fail with `ENOTSUP` as under NODEFS and NODERAWFS, and which WasmFS carries out.
- **Duplicate search.** "wasmfs O_WRONLY", "node backend r+", "write-only file wasmfs" and a scan of open "wasmfs"
  issues turned up nothing before #27847.
- **Why it matters to us.** Test programs run on WasmFS over the host through the Node backend; a program that writes a
  file it has made write-only fails there and nowhere else.
- ibus-web carries this fix as `modules/emscripten/patches/0023-wasmfs-node-open-wronly.patch`.
