# Node file systems: `unlink()` on a directory fails with the host's error, so removing a directory fails on macOS

**Not posted.** An Emscripten issue, then its PR (0025 rebased onto `main`). No dependencies. ibus-web carries the fix
as 0025.

Checked against `main` 5f63ff2 (2026-10-17): `NODERAWFS.unlink` in `src/lib/libnoderawfs.js`, `_wasmfs_node_unlink` in
`src/lib/libwasmfs_node.js` and the Node backend's `removeChild()` are unchanged, and no issue mentions them.

## Issue title

Node file systems: removing a directory fails on macOS, since unlink() reports EPERM instead of EISDIR

## Issue body

---

Both of Emscripten's Node file systems unlink through Node's `fs.unlinkSync()`, so on a directory they fail with
whatever the host's `unlink(2)` does. Linux fails with `EISDIR`; macOS fails with `EPERM` ("The named file is a
directory", `unlink(2)` on Darwin), as POSIX allows. Both callers fall back to `rmdir` on `EISDIR` alone:

- **NODERAWFS:** musl's `remove()` calls `unlink()`, then `rmdir()` on `EISDIR`, so on a macOS host `remove()` of a
  directory fails with `EPERM`.
- **WasmFS's Node backend:** `removeChild()` calls `_wasmfs_node_unlink()`, then `_wasmfs_node_rmdir()` on `EISDIR`, and
  serves `rmdir()` as well as `unlink()`, so on a macOS host `rmdir()` fails with `EPERM` too, and so does `remove()`.

Everything built on them fails with it, such as GLib's `g_remove()`, `g_rmdir()` and `g_file_delete()`. The program is
built for a Linux-like libc and gets macOS's answer.

**Version of emscripten/emsdk:**

```
emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 6.0.9-git
clang version 22.1.8
Target: wasm32-unknown-emscripten
Thread model: posix
```

This is the 6.0.9 release tag as packaged by nixpkgs. Node.js v26.11.1 on macOS 26 (arm64).

**Test case** (`remove_dir.c`):

```c
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

int main(void) {
  mkdir("d", 0700);
  if (unlink("d") == -1) printf("unlink: %s\n", strerror(errno));
  if (remove("d") == -1) printf("remove: %s\n", strerror(errno));
  else printf("removed\n");
  return 0;
}
```

**Failing command lines in full:**

```
$ emcc -sNODERAWFS remove_dir.c -o remove_dir.js && node remove_dir.js
unlink: Operation not permitted
remove: Operation not permitted
$ emcc -sWASMFS -sNODERAWFS remove_dir.c -o remove_dir.js && node remove_dir.js
unlink: Is a directory
remove: Operation not permitted
```

On a Linux host, and natively on either:

```
unlink: Is a directory
removed
```

**Where:** `NODERAWFS.unlink` and `_wasmfs_node_unlink` pass straight through to `fs.unlinkSync()`
([libnoderawfs.js#L102](https://github.com/emscripten-core/emscripten/blob/main/src/lib/libnoderawfs.js#L102),
[libwasmfs_node.js#L141](https://github.com/emscripten-core/emscripten/blob/main/src/lib/libwasmfs_node.js#L141)), and
musl's `remove()` and the backend's `removeChild()` fall back on `EISDIR` alone
([remove.c](https://github.com/emscripten-core/emscripten/blob/main/system/lib/libc/musl/src/stdio/remove.c),
[node_backend.cpp#L208](https://github.com/emscripten-core/emscripten/blob/main/system/lib/wasmfs/backends/node_backend.cpp#L208)).

**Suggested fix:** have both fail with `EISDIR` on a directory, as Linux does, whatever the host. NODERAWFS:

```diff
-    unlink(...args) { fs.unlinkSync(...args); },
+    unlink(path) {
+      if (fs.lstatSync(path).isDirectory()) {
+        throw new FS.ErrnoError({{{ cDefs.EISDIR }}});
+      }
+      fs.unlinkSync(path);
+    },
```

WasmFS's Node backend:

```diff
   _wasmfs_node_unlink: (path_p) => {
     return wasmfsTry(() => {
-      fs.unlinkSync(UTF8ToString(path_p))
+      var path = UTF8ToString(path_p);
+      if (fs.lstatSync(path).isDirectory()) {
+        return {{{ cDefs.EISDIR }}};
+      }
+      fs.unlinkSync(path)
     });
   },
```

---

## Evidence

Found running GLib's test suite, on WasmFS's Node backend, on a macOS host: `gio/tests/contenttype`'s
`tree_invalid_encoding` failed with "Error removing file …: Operation not permitted" deleting its temporary directory
through `g_file_delete()`, and `glib/tests/fileutils`'s `mkdir-with-parents` with "assertion failed (rmdir
(dac_denies_write) >= 0): errno 63: Operation not permitted". The test case's output above is what the issue expects,
not a recorded run: the macOS runner the failure came from has no interactive shell, and the build machine here is
Linux, where the host already gives `EISDIR`. `checks.emscripten-fixes` holds the same checks in GoogleTest form
(`unlink-directory.cpp`, built for both file systems), which pass on Linux with or without the patch and fail only on a
macOS host without it.
