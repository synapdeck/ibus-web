# WasmFS: `open(O_CREAT)` ignores the parent directory's write permission

**Posted: don't post again.** The comment below went on #18033 on
2026-10-01; no reply yet. Its suggested fix (patch 0007) can follow as a PR
once a maintainer answers.

Checked against `main` 5977ecc (2026-10-02): `doOpen()`'s create path still
skips the parent's write check, and 0007 applies there with a 2-line offset.

**Draft: do not post as a new issue.** This is already reported as
[#18033](https://github.com/emscripten-core/emscripten/issues/18033) ("WasmFS: A
file can be created in a read-only directory", open since 2022; one maintainer
comment: "I think the permissions checking is a bit spotty overall."). Post the
text below as a **comment on #18033**.

## Comment for #18033

---

This still reproduces on 6.0.9. It's specific to file creation through `open`
(and `mknod`, which goes through the same `doOpen`). In the same read-only
directory, `mkdir` and `unlink` already fail with `EACCES` (`rename` has the
same check in the source), and the JS file system rejects all three calls the
test makes.

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

**Test case** (`create_perm.c`):

```c
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static void report(const char *what, int r) {
  printf("%-40s %s\n", what, r < 0 ? strerror(errno) : "succeeded");
}

int main(void) {
  printf("uid %d\n", (int)getuid());
  mkdir("/ro", 0777);
  close(open("/ro/existing", O_CREAT | O_WRONLY, 0666));
  /* Searchable and readable, but not writable. */
  chmod("/ro", 0555);

  errno = 0;
  report("mkdir(\"/ro/dir\")", mkdir("/ro/dir", 0777));
  errno = 0;
  report("unlink(\"/ro/existing\")", unlink("/ro/existing"));
  errno = 0;
  int fd = open("/ro/new", O_CREAT | O_WRONLY, 0666);
  report("open(\"/ro/new\", O_CREAT|O_WRONLY)", fd);
  if (fd >= 0)
    close(fd);
  struct stat st;
  printf("/ro/new exists afterwards: %s\n", stat("/ro/new", &st) == 0 ? "yes" : "no");
  return 0;
}
```

**Failing command line in full** (the same at `-O2`):

```
$ emcc -O0 -sWASMFS create_perm.c -o create_perm.js && node create_perm.js
uid 0
mkdir("/ro/dir")                         Permission denied
unlink("/ro/existing")                   Permission denied
open("/ro/new", O_CREAT|O_WRONLY)        succeeded
/ro/new exists afterwards: yes
```

JS file system, for comparison:

```
$ emcc -O0 create_perm.c -o create_perm.js && node create_perm.js
uid 0
mkdir("/ro/dir")                         Permission denied
unlink("/ro/existing")                   Permission denied
open("/ro/new", O_CREAT|O_WRONLY)        Permission denied
/ro/new exists afterwards: no
```

<details>
<summary>Full compile and link output with <code>-v</code> appended (cache and scratch paths shortened)</summary>

```
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/clang -target wasm32-unknown-emscripten -fignore-exceptions -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr --sysroot=$EM_CACHE/sysroot -resource-dir=/nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter$EM_CACHE/sysroot/include -iwithsysroot/include/c++/v1 -Xclang -iwithsysroot/include/fakesdl -Xclang -iwithsysroot/include/compat -v -O0 -c create_perm.c -o /tmp/emscripten_temp_6mommx4r/create_perm.o
clang version 22.1.8
Target: wasm32-unknown-emscripten
Thread model: posix
InstalledDir: /nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin
 (in-process)
 "/nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin/clang-22" -cc1 -triple wasm32-unknown-emscripten -O0 -emit-obj -disable-free -clear-ast-before-backend -disable-llvm-verifier -discard-value-names -main-file-name create_perm.c -mrelocation-model static -mframe-pointer=none -ffp-contract=on -fno-rounding-math -mconstructor-aliases -target-cpu generic -fvisibility=hidden -debugger-tuning=gdb -fdebug-compilation-dir=. -v -fcoverage-compilation-dir=. -resource-dir /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter $EM_CACHE/sysroot/include -iwithsysroot /include/c++/v1 -isysroot $EM_CACHE/sysroot -internal-isystem /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/include -internal-isystem $EM_CACHE/sysroot/include/wasm32-emscripten -internal-isystem $EM_CACHE/sysroot/include -ferror-limit 19 -fgnuc-version=4.2.1 -fskip-odr-check-in-gmf -fignore-exceptions -iwithsysroot/include/fakesdl -iwithsysroot/include/compat -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr -o /tmp/emscripten_temp_6mommx4r/create_perm.o -x c create_perm.c
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
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/wasm-ld -o create_perm.wasm /tmp/tmpjw032n2mlibemscripten_js_symbols.so -Bstatic --strip-debug --export=emscripten_stack_get_end --export=emscripten_stack_get_free --export=emscripten_stack_get_base --export=emscripten_stack_get_current --export=emscripten_stack_init --export=wasmfs_flush --export=_emscripten_stack_alloc --export=__wasm_call_ctors --export=_emscripten_stack_restore --export-if-defined=__start_em_asm --export-if-defined=__stop_em_asm --export-if-defined=__start_em_lib_deps --export-if-defined=__stop_em_lib_deps --export-if-defined=__start_em_js --export-if-defined=__stop_em_js --export-if-defined=main --export-if-defined=__main_argc_argv --export-if-defined=fflush --export-table -z stack-size=65536 --no-growable-memory --initial-heap=16777216 --no-entry --stack-first --table-base=1 /tmp/emscripten_temp_6mommx4r/create_perm.o -L$EM_CACHE/sysroot/lib/wasm32-emscripten -L/nix/store/03iyrnrsxnbc64y6r62irmlbnbap5ya2-emscripten-6.0.9/share/emscripten/src/lib -lGL-getprocaddr -lal -lhtml5 -lstubs-debug -lnoexit -lc-debug -ldlmalloc-debug -lclang_rt.builtins -lc++-debug-noexcept -lc++abi-debug-noexcept -lsockets -lwasmfs_no_fs -lwasmfs-debug -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/llvm-objcopy create_perm.wasm create_perm.wasm '--remove-section=llvm.func_attr.annotate.*' --remove-section=producers --remove-section=name '--remove-section=.debug*'
```

</details>

**Where:** `doOpen` has `// TODO: Check write permissions on the parent
directory.` where it creates the file
([syscalls.cpp#L478](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/syscalls.cpp#L478)).
`doMkdir` does the check
([syscalls.cpp#L634-L636](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/syscalls.cpp#L634-L636)),
and so do `unlink`
([#L873](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/syscalls.cpp#L873))
and `rename`
([#L1045](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/syscalls.cpp#L1045)).

**Suggested fix:** the same check as `doMkdir`.

```diff
--- a/system/lib/wasmfs/syscalls.cpp
+++ b/system/lib/wasmfs/syscalls.cpp
@@ -475,7 +475,9 @@
         backend = parent->getBackend();
       }

-      // TODO: Check write permissions on the parent directory.
+      if (!(lockedParent.getMode() & WASMFS_PERM_WRITE)) {
+        return -EACCES;
+      }
       std::shared_ptr<File> created;
       if (backend == parent->getBackend()) {
         created = lockedParent.insertDataFile(std::string(childName), mode);
```

With this applied to 6.0.9, the test case matches the JS FS:

```
uid 0
mkdir("/ro/dir")                         Permission denied
unlink("/ro/existing")                   Permission denied
open("/ro/new", O_CREAT|O_WRONLY)        Permission denied
/ro/new exists afterwards: no
```

---

## Evidence

- **FAQ and docs.** The FAQ doesn't cover permissions. The File System API page
  says only owner permissions apply. WasmFS's code checks for any write bit
  (`0222`) and ignores ownership. The test clears every write bit (mode `0555`),
  so it doesn't depend on that difference. Run at `-O0` and `-O2`, with the same
  result.
- **bug_reports.rst.** The source, `emcc -v`, the symptoms and a tested fix are
  included. Bitcode is left out because the fault is in `libwasmfs`. The guide
  prefers a PR: this is a three-line change plus a test, so offering one in the
  comment would likely move it faster.
- **Interaction with the Node backend.** With the check missing, `open(O_CREAT)`
  in a host directory the user can't write reaches the host. The host refuses,
  and WasmFS reports `EIO` (see `emscripten-wasmfs-node-create-eio.md`). With
  this fix, WasmFS answers `EACCES` itself whenever its idea of the directory's
  mode is right.
- **Duplicate search.** "wasmfs O_CREAT permission", "permission check parent
  directory create", "wasmfs EACCES", "EACCES" and "wasmfs permission", plus a
  scan of all open "wasmfs" issues, turned up #18033 (this bug) and nothing
  else close.
- **Why it matters to us.** GLib's
  `/fileutils/set-contents-full/read-only-directory` fails on WasmFS, partly
  because of this (see also `emscripten-wasmfs-search-permission.md`).
- **Tip-of-tree.** Checked read-only through the GitHub API on 2026-09-30: the
  cited `doOpen` and `doMkdir` code is unchanged between 6.0.9 and `main`
  (2151200, 139 commits later). `syscalls.cpp` changed only in `fdatasync`'s
  error sign (#27806) and `utimensat`'s timestamp rounding; the cited code is
  unchanged, a few lines further down. The latest release, 6.0.10 (tagged
  2026-09-18), matches. The conclusion comes from the diff; `main` wasn't
  rebuilt. Our build is nixpkgs' 6.0.9 with LLVM 22.1.8. #18033 was open on
  2026-09-30.
- ibus-web carries this fix as `modules/emscripten/patches/0007-wasmfs-create-permission.patch`.
