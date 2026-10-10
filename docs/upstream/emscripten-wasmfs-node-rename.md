# WasmFS Node backend: a renamed file or directory keeps its old host path

**Posted: don't post again.** Filed as [#27824](https://github.com/emscripten-core/emscripten/issues/27824)
(2026-10-01), with the fix (0011, directories included) and a test as PR
[#27849](https://github.com/emscripten-core/emscripten/pull/27849) ("[WasmFS] Update host paths of renamed files in the
Node backend", open, no review yet). #27849 explains how its locks sit with
[#27685](https://github.com/emscripten-core/emscripten/pull/27685) (someone else's open fix for a lock-order deadlock in
`renameat`, #27684): neither depends on the other.

Checked against `main` 5977ecc (2026-10-02): the Node backend and `renameat` are unchanged since 6.0.9 (#27685 isn't
merged), and 0011 applies there alone with offsets only.

**Draft: new issue.** No existing issue covers it.

## Issue title

WasmFS Node backend: after rename(), a file (or anything already looked up under a renamed directory) still refers to
its old host path

## Issue body

---

After `rename("/host/a", "/host/b")` on a `wasmfs_create_node_backend()` directory, the host file is renamed, but
WasmFS's `File` object for it still holds the host path `…/a`. Every later open of `/host/b` opens the host's `…/a`. If
nothing is at `…/a`, the open fails on the host (which then surfaces confusingly, see below). If something new has been
created at `…/a`, reads and writes through `/host/b` silently go to that other file.

**Version of emscripten/emsdk:**

```
emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 6.0.9-git
clang version 22.1.8
Target: wasm32-unknown-emscripten
Thread model: posix
InstalledDir: /nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin
```

This is the 6.0.9 release tag as packaged by nixpkgs. nixpkgs builds it against its own LLVM 22.1.8, so there is no
commit hash. Node.js v24.20.0, x86_64 Linux.

**Test case** (`node_rename.c`; `argv[1]` is an existing host directory):

```c
#include <emscripten/wasmfs.h>
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>

static void put(const char *path, const char *text, size_t len) {
  int fd = open(path, O_CREAT | O_WRONLY | O_TRUNC, 0644);
  write(fd, text, len);
  close(fd);
}

int main(int argc, char **argv) {
  /* argv[1]: an existing host directory, mounted at /host. */
  wasmfs_create_directory("/host", 0777, wasmfs_create_node_backend(argv[1]));

  put("/host/a", "contents of a\n", 14);
  printf("rename(\"/host/a\", \"/host/b\") = %d\n", rename("/host/a", "/host/b"));
  /* Reuse the old name for an unrelated file. */
  put("/host/a", "a new file a\n", 13);

  char buf[32] = {0};
  int fd = open("/host/b", O_RDONLY);
  ssize_t n = read(fd, buf, sizeof buf - 1);
  close(fd);
  printf("read(\"/host/b\") = %zd: %s", n, buf);
  return 0;
}
```

**Failing command line in full** (the same at `-O2`):

```
$ emcc -O0 -sWASMFS node_rename.c -o node_rename.js && mkdir host && node node_rename.js "$PWD/host" && head host/*
rename("/host/a", "/host/b") = 0
read("/host/b") = 13: a new file a
==> host/a <==
a new file a

==> host/b <==
contents of a
```

Expected `read("/host/b") = 14: contents of a`.

Renaming a directory leaves its already-looked-up children pointing at the old directory too (`node_rename_dir.c`):

```c
#include <emscripten/wasmfs.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

int main(int argc, char **argv) {
  wasmfs_create_directory("/host", 0777, wasmfs_create_node_backend(argv[1]));
  mkdir("/host/d", 0777);
  int fd = open("/host/d/f", O_CREAT | O_WRONLY | O_TRUNC, 0644);
  write(fd, "in f\n", 5);
  close(fd);
  printf("rename dir = %d\n", rename("/host/d", "/host/e"));
  char buf[16] = {0};
  errno = 0;
  fd = open("/host/e/f", O_RDONLY);
  ssize_t n = read(fd, buf, sizeof buf - 1);
  printf("read(\"/host/e/f\") = %zd (%s) %s", n, n < 0 ? strerror(errno) : "ok", buf);
  if (n <= 0) printf("\n");
  return 0;
}
```

```
$ emcc -O0 -sWASMFS node_rename_dir.c -o node_rename_dir.js && mkdir host && node node_rename_dir.js "$PWD/host"
rename dir = 0
read("/host/e/f") = -1 (Bad file descriptor)
```

<details>
<summary>Full compile and link output with <code>-v</code> appended (cache and scratch paths shortened)</summary>

```
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/clang -target wasm32-unknown-emscripten -fignore-exceptions -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr --sysroot=$EM_CACHE/sysroot -resource-dir=/nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter$EM_CACHE/sysroot/include -iwithsysroot/include/c++/v1 -Xclang -iwithsysroot/include/fakesdl -Xclang -iwithsysroot/include/compat -v -O0 -c node_rename.c -o /tmp/emscripten_temp_b4blae6e/node_rename.o
clang version 22.1.8
Target: wasm32-unknown-emscripten
Thread model: posix
InstalledDir: /nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin
 (in-process)
 "/nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin/clang-22" -cc1 -triple wasm32-unknown-emscripten -O0 -emit-obj -disable-free -clear-ast-before-backend -disable-llvm-verifier -discard-value-names -main-file-name node_rename.c -mrelocation-model static -mframe-pointer=none -ffp-contract=on -fno-rounding-math -mconstructor-aliases -target-cpu generic -fvisibility=hidden -debugger-tuning=gdb -fdebug-compilation-dir=. -v -fcoverage-compilation-dir=. -resource-dir /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter $EM_CACHE/sysroot/include -iwithsysroot /include/c++/v1 -isysroot $EM_CACHE/sysroot -internal-isystem /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/include -internal-isystem $EM_CACHE/sysroot/include/wasm32-emscripten -internal-isystem $EM_CACHE/sysroot/include -ferror-limit 19 -fgnuc-version=4.2.1 -fskip-odr-check-in-gmf -fignore-exceptions -iwithsysroot/include/fakesdl -iwithsysroot/include/compat -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr -o /tmp/emscripten_temp_b4blae6e/node_rename.o -x c node_rename.c
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
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/wasm-ld -o node_rename.wasm /tmp/tmpdjwwqga2libemscripten_js_symbols.so -Bstatic --strip-debug --export=emscripten_stack_get_end --export=emscripten_stack_get_free --export=emscripten_stack_get_base --export=emscripten_stack_get_current --export=emscripten_stack_init --export=wasmfs_flush --export=_emscripten_stack_alloc --export=__wasm_call_ctors --export=_emscripten_stack_restore --export-if-defined=__start_em_asm --export-if-defined=__stop_em_asm --export-if-defined=__start_em_lib_deps --export-if-defined=__stop_em_lib_deps --export-if-defined=__start_em_js --export-if-defined=__stop_em_js --export-if-defined=main --export-if-defined=__main_argc_argv --export-if-defined=fflush --export-table -z stack-size=65536 --no-growable-memory --initial-heap=16777216 --no-entry --stack-first --table-base=1 /tmp/emscripten_temp_b4blae6e/node_rename.o -L$EM_CACHE/sysroot/lib/wasm32-emscripten -L/nix/store/03iyrnrsxnbc64y6r62irmlbnbap5ya2-emscripten-6.0.9/share/emscripten/src/lib -lGL-getprocaddr -lal -lhtml5 -lstubs-debug -lnoexit -lc-debug -ldlmalloc-debug -lclang_rt.builtins -lc++-debug-noexcept -lc++abi-debug-noexcept -lsockets -lwasmfs_no_fs -lwasmfs-debug -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/llvm-objcopy node_rename.wasm node_rename.wasm '--remove-section=llvm.func_attr.annotate.*' --remove-section=producers --remove-section=name '--remove-section=.debug*'
```

</details>

**Where:**

- `NodeDirectory::insertMove` renames on the host but never updates the moved file's `state.path`
  ([node_backend.cpp#L247-L260](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/backends/node_backend.cpp#L247-L260)).
- `NodeState::open` then opens that stale path
  ([node_backend.cpp#L39-L88](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/backends/node_backend.cpp#L39-L88)).
- Node directories don't maintain file identity, so the moved `File` stays in the new parent's dcache, path and all.
- A directory's cached children each carry a full host path built from the directory's old path, and so do theirs, all
  the way down.
- Moving a symlink takes the `else` branch and casts it to `NodeDirectory`.

**Suggested fix:** rewrite the cached host path of the moved file and of every file the backend has already loaded below
it, with all of them locked across the host's rename.

```diff
--- a/system/lib/wasmfs/backends/node_backend.cpp
+++ b/system/lib/wasmfs/backends/node_backend.cpp
@@ -204,6 +204,31 @@
     return state.path + '/' + name;
   }

+  // The host path a file, directory or symlink of this backend refers to.
+  static std::string& getHostPath(const std::shared_ptr<File>& file) {
+    if (file->is<DataFile>()) {
+      return std::static_pointer_cast<NodeFile>(file)->state.path;
+    }
+    if (file->is<Directory>()) {
+      return std::static_pointer_cast<NodeDirectory>(file)->state.path;
+    }
+    return std::static_pointer_cast<NodeSymlink>(file)->path;
+  }
+
+  // Lock `file` and every file below it that this backend has loaded, each
+  // before its children, as path lookups do. Every one of them caches a host
+  // path under the one being renamed.
+  static void lockLoaded(const std::shared_ptr<File>& file,
+                         std::vector<File::Handle>& locked) {
+    locked.push_back(file->locked());
+    if (file->is<Directory>()) {
+      auto dir = std::static_pointer_cast<NodeDirectory>(file);
+      for (auto& child : dir->getLoadedChildren()) {
+        lockLoaded(child, locked);
+      }
+    }
+  }
+
   std::shared_ptr<File> getChild(const std::string& name) override {
     static_assert(std::is_same_v<mode_t, unsigned int>);
     // TODO: also retrieve and set ctime, atime, ino, etc.
@@ -269,18 +294,26 @@
   }

   int insertMove(const std::string& name, std::shared_ptr<File> file) override {
-    std::string fromPath;
-
-    if (file->is<DataFile>()) {
-      auto nodeFile = std::static_pointer_cast<NodeFile>(file);
-      fromPath = nodeFile->state.path;
-    } else {
-      auto nodeDir = std::static_pointer_cast<NodeDirectory>(file);
-      fromPath = nodeDir->state.path;
+    // A mount point of another backend has no host path here to move; Linux
+    // refuses to rename a mount point too.
+    if (file->getBackend() != getBackend()) {
+      return -EBUSY;
     }

+    // Holding the locks across the host's rename means no operation on a moved
+    // file sees its host path change under it.
+    std::vector<File::Handle> locked;
+    lockLoaded(file, locked);
+
+    auto fromPath = getHostPath(file);
     auto childPath = getChildPath(name);
-    return -_wasmfs_node_rename(fromPath.c_str(), childPath.c_str());
+    if (auto err = _wasmfs_node_rename(fromPath.c_str(), childPath.c_str())) {
+      return -err;
+    }
+    for (auto& handle : locked) {
+      getHostPath(handle.unlocked()).replace(0, fromPath.size(), childPath);
+    }
+    return 0;
   }

   ssize_t getNumEntries() override {
--- a/system/lib/wasmfs/file.h
+++ b/system/lib/wasmfs/file.h
@@ -208,6 +208,19 @@
   std::map<std::string, DCacheEntry> dcache;

 protected:
+  // The children this directory's backend has returned that are still in the
+  // dcache. Mount points belong to other backends and are left out. The
+  // directory must be locked.
+  std::vector<std::shared_ptr<File>> getLoadedChildren() {
+    std::vector<std::shared_ptr<File>> children;
+    for (auto& [name, entry] : dcache) {
+      if (entry.kind == DCacheKind::Normal) {
+        children.push_back(entry.file);
+      }
+    }
+    return children;
+  }
+
   // Return the `File` object corresponding to the file with the given name or
   // null if there is none.
   virtual std::shared_ptr<File> getChild(const std::string& name) = 0;
```

Why this shape:

- **Rewriting rather than deriving.** The other way to fix it is to stop caching absolute host paths and build each one
  from the parent chain when it's needed. But an operation on a file runs with the file locked, and reading its parent
  and its name in the parent's dcache would then lock the parent too: child before parent, the order #27684 shows
  deadlocking against path lookups. It would also deadlock against `rename()` itself, which holds both parents and then
  locks the moved file. Rewriting touches only `insertMove`, and only a rename pays for it.
- **Mount points.** A mount point inside a Node directory reaches `insertMove` too, as a file of another backend;
  casting it to a Node type would write through the wrong object. It fails with `EBUSY`, Linux's answer for renaming a
  mount point (6.0.9 asks the host to rename a path that doesn't exist and gets `ENOENT`, after a cast that is undefined
  behaviour).
- **The walk.** Node directories don't maintain file identity, so every file the backend has handed out that is still
  linked is in its parent's dcache. `Directory`'s dcache is private, so the patch adds a protected `getLoadedChildren()`
  for backends. Mount points are skipped: they belong to other backends and carry their own paths.
- **Locking.** `lockLoaded` locks the moved file and then each loaded file below it, each before its children: the order
  path lookups use (and the order #27685 moves `renameat` to). `renameat` already holds both parents and serializes
  renames. Holding the locks across the host's `rename` means an operation already running on one of those files
  finishes with the old path, and one that starts afterwards sees the new one. Rewriting the paths after the host's
  rename, each under its own lock, isn't enough: in the racing part of the test below, 876 of the reader's lookups
  failed with `ENOENT` in one run.

With this applied to 6.0.9 (together with the `fsync` fix and the `open`/`close` fix reported separately, which the
third test uses), the first test case prints:

```
rename("/host/a", "/host/b") = 0
read("/host/b") = 14: contents of a
```

the second:

```
rename dir = 0
read("/host/e/f") = 5 (ok) in f
```

and this test (`node_rename_tree.c`), which renames a directory holding open and closed files, a symlink, subdirectories
and the working directory, then reads, writes and stats through the old descriptors and through fresh opens, checks with
Node's own `fs` that the old names are gone, does nested and cross-directory renames, and finally renames a directory
back and forth 2000 times while another thread opens a file relative to it:

<details>
<summary><code>node_rename_tree.c</code></summary>

```c
#include <emscripten/em_js.h>
#include <emscripten/wasmfs.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/* What the host sees, through Node's own fs. */
EM_JS(int, host_exists, (const char *path), {
  return require('fs').existsSync(UTF8ToString(path)) ? 1 : 0;
});
EM_JS(int, host_read, (const char *path, char *buf, int size), {
  try {
    return stringToUTF8(require('fs').readFileSync(UTF8ToString(path), 'utf8'), buf, size);
  } catch (e) {
    return -1;
  }
});

static const char *hostdir;
static int failures;

#define CHECK(cond, ...)                                                       \
  do {                                                                         \
    if (!(cond)) {                                                             \
      failures++;                                                              \
      printf("FAIL %s:%d: ", __FILE__, __LINE__);                              \
      printf(__VA_ARGS__);                                                     \
      printf(" (errno %s)\n", strerror(errno));                                \
    }                                                                          \
  } while (0)

static void put(const char *path, const char *text) {
  int fd = open(path, O_CREAT | O_WRONLY | O_TRUNC, 0644);
  CHECK(fd >= 0, "create %s", path);
  CHECK(write(fd, text, strlen(text)) == (ssize_t)strlen(text), "write %s", path);
  close(fd);
}

static void expect_file(const char *path, const char *text) {
  char buf[64] = {0};
  struct stat st;
  CHECK(stat(path, &st) == 0 && st.st_size == (off_t)strlen(text), "stat %s", path);
  int fd = open(path, O_RDONLY);
  CHECK(fd >= 0, "open %s", path);
  ssize_t n = read(fd, buf, sizeof buf - 1);
  CHECK(n == (ssize_t)strlen(text) && strcmp(buf, text) == 0, "read %s: %zd \"%s\"", path, n, buf);
  CHECK(close(fd) == 0, "close %s", path);
}

static void expect_host(const char *rel, const char *text) {
  char path[256], buf[64] = {0};
  snprintf(path, sizeof path, "%s/%s", hostdir, rel);
  if (text == NULL) {
    CHECK(!host_exists(path), "host still has %s", rel);
    return;
  }
  CHECK(host_read(path, buf, sizeof buf) >= 0 && strcmp(buf, text) == 0, "host %s: \"%s\"", rel, buf);
}

static int dirfd_c;
static volatile int done;
static int thread_failures;

static void *reader(void *arg) {
  /* The directory renames under us, but an fd-relative open goes through the
   * directory object and must always find its file. */
  for (int i = 0; !done; i++) {
    int fd = openat(dirfd_c, "f", O_RDONLY);
    char c = 0;
    if (fd < 0 || read(fd, &c, 1) != 1 || c != 'c') {
      thread_failures++;
      printf("reader: iteration %d: fd %d, %s\n", i, fd, strerror(errno));
    }
    if (fd >= 0)
      close(fd);
  }
  return NULL;
}

int main(int argc, char **argv) {
  hostdir = argv[1];
  wasmfs_create_directory("/host", 0777, wasmfs_create_node_backend(hostdir));

  mkdir("/host/d", 0777);
  mkdir("/host/d/sub", 0777);
  mkdir("/host/d/sub/deep", 0777);
  put("/host/d/f", "f1");
  put("/host/d/g", "g1");
  put("/host/d/sub/h", "h1");
  put("/host/d/sub/i", "i1");
  put("/host/d/sub/deep/j", "j1");
  symlink("g", "/host/d/link");

  /* Kept open across the renames: one file at the top, one nested. */
  int f = open("/host/d/f", O_RDWR);
  int h = open("/host/d/sub/h", O_RDWR);
  CHECK(f >= 0 && h >= 0, "open f, h");
  /* Looked up (and so cached) but closed. */
  struct stat st;
  CHECK(stat("/host/d/g", &st) == 0, "stat g");
  CHECK(stat("/host/d/sub/i", &st) == 0, "stat i");
  CHECK(stat("/host/d/sub/deep/j", &st) == 0, "stat j");
  /* A working directory inside the tree. */
  CHECK(chdir("/host/d/sub") == 0, "chdir");

  printf("rename d -> e: %d\n", rename("/host/d", "/host/e"));
  expect_host("d", NULL);

  /* Old handles. */
  CHECK(pwrite(f, "F2", 2, 0) == 2, "pwrite old f");
  CHECK(fstat(f, &st) == 0 && st.st_size == 2, "fstat old f");
  CHECK(pwrite(h, "H2", 2, 0) == 2, "pwrite old h");
  CHECK(fsync(h) == 0, "fsync old h");
  expect_host("e/f", "F2");
  expect_host("e/sub/h", "H2");
  /* Fresh opens of every file, open or not. */
  expect_file("/host/e/f", "F2");
  expect_file("/host/e/g", "g1");
  expect_file("/host/e/link", "g1");
  expect_file("/host/e/sub/h", "H2");
  expect_file("/host/e/sub/i", "i1");
  expect_file("/host/e/sub/deep/j", "j1");
  expect_file("i", "i1");
  put("/host/e/sub/deep/new", "n1");
  expect_host("e/sub/deep/new", "n1");
  put("k", "k1");
  expect_host("e/sub/k", "k1");
  CHECK(open("/host/d/f", O_RDONLY) < 0 && errno == ENOENT, "old name still opens");

  /* Nested renames: a subdirectory, then its parent, then across parents. */
  printf("rename e/sub -> e/sub2: %d\n", rename("/host/e/sub", "/host/e/sub2"));
  printf("rename e -> x: %d\n", rename("/host/e", "/host/x"));
  mkdir("/host/p", 0777);
  printf("rename x/sub2/deep -> p/moved: %d\n", rename("/host/x/sub2/deep", "/host/p/moved"));
  printf("rename x/g -> x/sub2/g: %d\n", rename("/host/x/g", "/host/x/sub2/g"));
  expect_host("e", NULL);
  expect_host("x/sub", NULL);
  expect_host("x/sub2/deep", NULL);
  expect_host("x/g", NULL);
  CHECK(pwrite(h, "H3", 2, 0) == 2, "pwrite old h");
  expect_host("x/sub2/h", "H3");
  expect_file("/host/x/f", "F2");
  expect_file("/host/x/sub2/g", "g1");
  expect_file("/host/x/sub2/h", "H3");
  expect_file("/host/x/sub2/i", "i1");
  expect_file("/host/p/moved/j", "j1");
  expect_file("/host/p/moved/new", "n1");
  expect_file("k", "k1");
  char cwd[256];
  CHECK(getcwd(cwd, sizeof cwd) && strcmp(cwd, "/host/x/sub2") == 0, "getcwd %s", cwd);
  CHECK(close(f) == 0 && close(h) == 0, "close f, h");

  /* Renames racing an fd-relative open in another thread. */
  mkdir("/host/c1", 0777);
  put("/host/c1/f", "c");
  dirfd_c = open("/host/c1", O_RDONLY | O_DIRECTORY);
  CHECK(dirfd_c >= 0, "open c1");
  pthread_t t;
  pthread_create(&t, NULL, reader, NULL);
  int renames = 0;
  for (int i = 0; i < 2000; i++) {
    CHECK(rename(i % 2 ? "/host/c2" : "/host/c1", i % 2 ? "/host/c1" : "/host/c2") == 0, "rename c");
    renames++;
  }
  done = 1;
  pthread_join(t, NULL);
  printf("racing renames: %d, reader failures: %d\n", renames, thread_failures);
  failures += thread_failures;
  expect_file("/host/c1/f", "c");

  printf("%s (%d failures)\n", failures ? "FAILED" : "PASSED", failures);
  return failures != 0;
}
```

</details>

```
$ emcc -O0 -pthread -sWASMFS -sPTHREAD_POOL_SIZE=2 -sEXIT_RUNTIME=1 node_rename_tree.c -o node_rename_tree.js && mkdir host && node node_rename_tree.js "$PWD/host"
rename d -> e: 0
rename e/sub -> e/sub2: 0
rename e -> x: 0
rename x/sub2/deep -> p/moved: 0
rename x/g -> x/sub2/g: 0
racing renames: 2000, reader failures: 0
PASSED (0 failures)
```

The same at `-O2`, and 20 runs of each passed. With only the moved file's own path updated, it fails 54 checks after the
first directory rename and the reader fails 1418 lookups.

**Related symptom:** when the stale path doesn't exist, the failed host `open` isn't reported as a failure. `open()`
returns a descriptor, `read()` then fails with `EBADF`, and `close()` trips `assert(ret >= 0)` in `__wasi_fd_close`.
That is a separate bug in how the backend handles host errors, reported in #NNNN.

---

## Evidence

- **Fill in #NNNN.** It is the issue number of `emscripten-wasmfs-node-open-close-errors.md` once that's posted. Or drop
  the paragraph if you post this one first.
- **FAQ.** Nothing in the FAQ covers it. Run at `-O0` and `-O2`, with the same result.
- **bug_reports.rst.** The source, `emcc -v`, the symptoms and a tested fix, for files and directories, are included.
  Bitcode is left out because the fault is in `libwasmfs`. A PR would want `node_rename_tree.c` as a `test/wasmfs` case.
- **The fix was tested** on a 6.0.9 tree with all of our carried fixes, at `-O0` and `-O2`, 20 runs each, and is part of
  the toolchain whose GLib test suite runs on it. The racing part distinguishes the locking: the unlocked rewrite failed
  876 lookups in one run, the files-only fix 1418.
- **#27684/#27685.** The lock-order deadlock in `renameat`'s ancestor walk is separate and pre-existing; the fix here
  locks only downward from the moved file, so it neither needs nor conflicts with #27685.
- ibus-web carries this fix as `modules/emscripten/patches/0011-wasmfs-node-rename.patch`.
- **Duplicate search.** "wasmfs node backend rename", "wasmfs rename node", "wasmfs rename", "insertMove", "wasmfs node
  backend" and "node_backend.cpp", plus a scan of all open "wasmfs" issues, turned up:
  - #26598 (merged), which fixed the sign of `insertMove`'s return value but not the path.
  - #24162 and #27684/#27685, which are about OPFS and lock-order rename bugs.
  - #15943 (closed, rename cycles). None is this bug.
- **Why it matters to us.** GLib's `g_file_set_contents()` writes a temporary file and renames it over the target. Under
  Node with host temp files, `bookmarkfile`, `keyfile`, `mappedfile`, `sandbox` and `async-splice-output-stream` hit it
  (through the `fd_close` assertion), and so did the GLib smoke test. The tests kept `TMPDIR` in memory to avoid it;
  with this fix and the other Node backend ones, they use a host `TMPDIR`.
- **Caveat maintainers may raise.** #19417 notes that WasmFS assumes it has complete control over the file system. The
  reproduction changes files only through WasmFS, so it doesn't depend on outside changes.
- **Tip-of-tree.** Checked read-only through the GitHub API on 2026-09-30: `node_backend.cpp` and `libwasmfs_node.js`
  are unchanged between 6.0.9 and `main` (2151200, 139 commits later). The latest release, 6.0.10 (tagged 2026-09-18),
  matches. The conclusion comes from the diff; `main` wasn't rebuilt. Our build is nixpkgs' 6.0.9 with LLVM 22.1.8.
