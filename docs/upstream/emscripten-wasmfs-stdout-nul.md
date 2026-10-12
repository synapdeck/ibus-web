# WasmFS: a NUL byte written to stdout or stderr comes out as a line break

**Not posted.** An Emscripten issue, then its PR (0024 rebased onto `main`). No dependencies. ibus-web carries the fix
as 0024.

Checked against `main` 0479680 (2026-10-12): `WritingStdFile` in `special_files.cpp` is unchanged since 6.0.9 (its last
change is #23263, January 2025), and 0024 applies there with offsets only.

## Issue title

WasmFS: stdout and stderr turn a NUL byte into a line break

## Issue body

---

WasmFS's standard output and error streams buffer what a program writes a line at a time and pass each line to
`emscripten_out()` or `emscripten_err()` as a C string. To do that, `WritingStdFile::writeToJS()` ends a line on a NUL
byte as well as on a line break, so a NUL the program writes comes out as a line break: `"a\0b\n"` prints `a`, a line
break, `b` and another line break. `flush()` relies on the same thing: it writes a NUL to push out a buffered last line.

Programs that write binary or NUL-separated output (`find -print0`-style lists, `gresource extract` of a resource
holding a NUL) get it changed on the way out. The JavaScript file system's TTY drops NUL bytes instead, and NODERAWFS
writes them through; WasmFS is the only one that adds line breaks.

**Version of emscripten/emsdk:**

```
emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 6.0.9-git
clang version 22.1.8
Target: wasm32-unknown-emscripten
Thread model: posix
InstalledDir: /nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin
```

This is the 6.0.9 release tag as packaged by nixpkgs. nixpkgs builds it against its own LLVM 22.1.8, so there is no
commit hash. Node.js v24.21.0, x86_64 Linux.

**Test case** (`stdout_nul.c`):

```c
#include <stdio.h>
#include <unistd.h>

int main(void) {
  write(STDOUT_FILENO, "a\0b\n", 4);
  fwrite("c\0d\n", 1, 4, stdout);
  fflush(stdout);
  return 0;
}
```

**Failing command line in full** (the same at `-O2`):

```
$ emcc -sWASMFS -sFORCE_FILESYSTEM stdout_nul.c -o stdout_nul.js && node stdout_nul.js | od -c
0000000   a  \n   b  \n   c  \n   d  \n
0000010
```

Native Linux:

```
$ cc stdout_nul.c -o stdout_nul && ./stdout_nul | od -c
0000000   a  \0   b  \n   c  \0   d  \n
0000010
```

(`-sFORCE_FILESYSTEM` keeps WasmFS's streams in a program this small; without it, `libwasmfs_no_fs` prints through the
JavaScript `fd_write`, whose `printChar()` also ends a line at a NUL.)

**Where:** `WritingStdFile::writeToJS()` flushes on `'\0'` as well as `'\n'`, and `flush()` writes a NUL to push out the
last line
([special_files.cpp#L79-L106](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/special_files.cpp#L79-L106)).

**Suggested fix:** end lines only on a line break, hand each one to `out()` or `err()` with its length through
`UTF8ToString(ptr, len, /*ignoreNul=*/true)`, and have `flush()` write the buffered line directly. One class serves both
streams, picking the console function by descriptor; `out()` and `err()` stay, for the reason the comment on them gives.

```diff
--- a/src/lib/libsigs.js
+++ b/src/lib/libsigs.js
@@ -466,6 +466,7 @@ sigs = {
   _wasmfs_stdin_get_char__sig: 'i',
   _wasmfs_thread_utils_heartbeat__sig: 'vp',
   _wasmfs_thread_utils_heartbeat_stop__sig: 'v',
+  _wasmfs_write_std_line__sig: 'vipp',
   alBuffer3f__sig: 'viifff',
   alBuffer3i__sig: 'viiiii',
   alBufferData__sig: 'viipii',
--- a/src/lib/libwasmfs.js
+++ b/src/lib/libwasmfs.js
@@ -629,5 +629,18 @@ addToLibrary({
       return c;
     }
     return -1;
-  }
+  },
+
+  _wasmfs_write_std_line__deps: ['$UTF8ToString'],
+  _wasmfs_write_std_line: (fd, str, len) => {
+    // out() and err() rather than console.log(), which under Node loses output
+    // from workers (https://github.com/emscripten-core/emscripten/issues/14804,
+    // https://github.com/nodejs/node/issues/40961).
+    var line = UTF8ToString(str, len, /*ignoreNul=*/true);
+    if (fd == 1) {
+      out(line);
+    } else {
+      err(line);
+    }
+  },
 });
--- a/system/lib/wasmfs/special_files.cpp
+++ b/system/lib/wasmfs/special_files.cpp
@@ -64,9 +64,11 @@ public:
   StdinFile() : DataFile(S_IRUGO, NullBackend, S_IFCHR) { seekable = false; }
 };

-// A standard stream that writes: stdout or stderr.
+// A standard stream that writes: stdout or stderr. Output goes to the console
+// a line at a time; a NUL byte is part of its line, like any other byte.
 class WritingStdFile : public DataFile {
-protected:
+  // The standard stream's descriptor, which picks the console function.
+  int fd;
   std::vector<char> writeBuffer;

   int open(oflags_t) override { return 0; }
@@ -76,69 +78,38 @@ protected:
     return -__WASI_ERRNO_INVAL;
   };

-  int flush() override {
-    // Write a null to flush the output if we have content.
-    if (!writeBuffer.empty()) {
-      const uint8_t nothing = '\0';
-      write(&nothing, 1, 0);
-    }
-    return 0;
+  void writeLine() {
+    _wasmfs_write_std_line(fd, writeBuffer.data(), writeBuffer.size());
+    writeBuffer.clear();
   }

-  off_t getSize() override { return 0; }
-  int setSize(off_t size) override { return -EPERM; }
-
-  ssize_t writeToJS(const uint8_t* buf,
-                    size_t len,
-                    void (*console_write)(const char*),
-                    std::vector<char>& fd_write_buffer) {
+  ssize_t write(const uint8_t* buf, size_t len, off_t offset) override {
     for (size_t j = 0; j < len; j++) {
       uint8_t current = buf[j];
-      // Flush on either a null or a newline.
-      if (current == '\0' || current == '\n') {
-        fd_write_buffer.push_back('\0'); // for null-terminated C strings
-        console_write(fd_write_buffer.data());
-        fd_write_buffer.clear();
+      if (current == '\n') {
+        writeLine();
       } else {
-        fd_write_buffer.push_back(current);
+        writeBuffer.push_back(current);
       }
     }
     return len;
   }

-public:
-  WritingStdFile() : DataFile(S_IWUGO, NullBackend, S_IFCHR) {
-    seekable = false;
+  int flush() override {
+    // Write out a last line that has no line break of its own.
+    if (!writeBuffer.empty()) {
+      writeLine();
+    }
+    return 0;
   }
-};

-class StdoutFile : public WritingStdFile {
-  ssize_t write(const uint8_t* buf, size_t len, off_t offset) override {
-    // Node and worker threads issue in Emscripten:
-    // https://github.com/emscripten-core/emscripten/issues/14804.
-    // Issue filed in Node: https://github.com/nodejs/node/issues/40961
-    // This is confirmed to occur when running with EXIT_RUNTIME and
-    // PROXY_TO_PTHREAD. This results in only a single console.log statement
-    // being outputted. The solution for now is to use out() and err() instead.
-    return writeToJS(buf, len, &emscripten_out, writeBuffer);
-  }
+  off_t getSize() override { return 0; }
+  int setSize(off_t size) override { return -EPERM; }

 public:
-  StdoutFile() {}
-};
-
-class StderrFile : public WritingStdFile {
-  ssize_t write(const uint8_t* buf, size_t len, off_t offset) override {
-    // Similar issue with Node and worker threads as emscripten_out.
-    // TODO: May not want to proxy stderr (fd == 2) to the main thread, as
-    //       emscripten_err does.
-    //       This will not show in HTML - a console.warn in a worker is
-    //       sufficient. This would be a change from the current FS.
-    return writeToJS(buf, len, &emscripten_err, writeBuffer);
+  WritingStdFile(int fd) : DataFile(S_IWUGO, NullBackend, S_IFCHR), fd(fd) {
+    seekable = false;
   }
-
-public:
-  StderrFile() {}
 };

 class RandomFile : public DataFile {
@@ -179,12 +150,12 @@ std::shared_ptr<DataFile> getStdin() {
 }

 std::shared_ptr<DataFile> getStdout() {
-  static auto stdout = std::make_shared<StdoutFile>();
+  static auto stdout = std::make_shared<WritingStdFile>(STDOUT_FILENO);
   return stdout;
 }

 std::shared_ptr<DataFile> getStderr() {
-  static auto stderr = std::make_shared<StderrFile>();
+  static auto stderr = std::make_shared<WritingStdFile>(STDERR_FILENO);
   return stderr;
 }

--- a/system/lib/wasmfs/wasmfs_internal.h
+++ b/system/lib/wasmfs/wasmfs_internal.h
@@ -21,6 +21,10 @@ void _wasmfs_copy_preloaded_file_data(uint32_t index, uint8_t* data);
 // Returns the next character from stdin, or -1 on EOF.
 int _wasmfs_stdin_get_char(void);

+// Writes a line of len bytes, NUL bytes included and with no line break of its
+// own, to stdout (fd 1) or stderr (fd 2): out() or err().
+void _wasmfs_write_std_line(int fd, const char* str, size_t len);
+
 #ifdef __cplusplus
 }
 #endif
```

With it, the test case prints what Linux does, at `-O0` and `-O2`:

```
$ node stdout_nul.js | od -c
0000000   a  \0   b  \n   c  \0   d  \n
0000010
```

---

## Evidence

- **Scope.** The streams stay a line-buffered text console, which the fix leaves alone: bytes that aren't UTF-8 are
  replaced (`UTF8ToString()` decodes each line), and `out()` ends a last line that has no line break of its own with
  one. Only the NUL is a WasmFS-only change to the data; the other two are what a console API does, and the JavaScript
  file system's TTY does the same. A byte-exact stdout under Node (writing to the process's descriptors, as NODERAWFS
  does) would be a separate request, and would bypass `Module.print`.
- **How the fix was tested.** On 6.0.9 with ibus-web's whole patch stack: the test case above at `-O0` and `-O2`, with
  and without pthreads, and `stderr` the same way. `checks.emscripten-fixes` (`Patch0024.NulStaysInItsLine`) writes a
  NUL inside a line to stdout and to stderr of a WasmFS program under Node and reads both back byte for byte.
- **Duplicate search.** "wasmfs stdout null", "wasmfs stdout binary", "wasmfs printf null byte", "wasmfs stdout
  newline", "stdout null character" and "fwrite stdout binary" turned up nothing on it. #23724 ("WASMFS hard-codes
  stdin, stdout, stderr behavior") is about replacing the streams, not their content.
- **bug_reports.rst.** The source, `emcc -v`, the symptoms and a tested fix are included. Bitcode is left out because
  the fault is in `libwasmfs`.
- **Why it matters to us.** GLib's tools run under Node, and `gresource extract` of a resource holding `a\0b\nc` printed
  `a\nb\nc\n` on WasmFS. With the fix the NUL survives, but the tools still link with `-sNODERAWFS`, whose stdout is the
  process's own descriptor: the console's UTF-8 decoding and added last line break would still change binary output.
- ibus-web carries this fix as `modules/emscripten/patches/0024-wasmfs-stdout-nul.patch`.
