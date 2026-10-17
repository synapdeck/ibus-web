# NODERAWFS: `unlink()` on a directory fails with the host's error, so `remove()` fails on macOS

**Not posted.** An Emscripten issue, then its PR (0025 rebased onto `main`). No dependencies. ibus-web carries the fix
as 0025.

Checked against `main` 5f63ff2 (2026-10-17): `NODERAWFS.unlink` in `src/lib/libnoderawfs.js` is unchanged (its last
change there is 19ad2dc, 2026-10-08, which doesn't touch it), and no issue mentions it.

## Issue title

NODERAWFS: remove() fails on a directory on macOS, since unlink() reports EPERM instead of EISDIR

## Issue body

---

NODERAWFS's `unlink()` is Node's `fs.unlinkSync()`, so on a directory it fails with whatever the host's `unlink(2)`
does. Linux fails with `EISDIR`; macOS fails with `EPERM` ("The named file is a directory", `unlink(2)` on Darwin), as
POSIX allows. musl's `remove()` calls `unlink()` and falls back to `rmdir()` only on `EISDIR`, so on a macOS host
`remove()` of a directory fails with `EPERM`, and so does everything built on it, such as GLib's `g_remove()` and
`g_file_delete()`. The program is built for a Linux-like libc and gets macOS's answer.

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

**Failing command line in full:**

```
$ emcc -sNODERAWFS remove_dir.c -o remove_dir.js && node remove_dir.js
unlink: Operation not permitted
remove: Operation not permitted
```

On a Linux host, and natively on either:

```
unlink: Is a directory
removed
```

**Where:** `NODERAWFS.unlink` passes straight through to `fs.unlinkSync()`
([libnoderawfs.js#L102](https://github.com/emscripten-core/emscripten/blob/main/src/lib/libnoderawfs.js#L102)), and
musl's `remove()` falls back on `EISDIR` alone
([remove.c](https://github.com/emscripten-core/emscripten/blob/main/system/lib/libc/musl/src/stdio/remove.c)).

**Suggested fix:** have `NODERAWFS.unlink` fail with `EISDIR` on a directory, as Linux does, whatever the host:

```diff
-    unlink(...args) { fs.unlinkSync(...args); },
+    unlink(path) {
+      if (fs.lstatSync(path).isDirectory()) {
+        throw new FS.ErrnoError({{{ cDefs.EISDIR }}});
+      }
+      fs.unlinkSync(path);
+    },
```

---

## Evidence

Found running GLib's test suite on a macOS host: `gio/tests/contenttype`'s `tree_invalid_encoding` failed with "Error
removing file …: Operation not permitted" deleting its temporary directory through `g_file_delete()`. The test case's
output above is what the issue expects, not a recorded run: the macOS runner the failure came from has no interactive
shell, and the build machine here is Linux, where the host already gives `EISDIR`. `checks.emscripten-fixes` holds the
same check in GoogleTest form (`noderawfs-unlink.cpp`), which passes on Linux with or without the patch and fails only
on a macOS host without it.
