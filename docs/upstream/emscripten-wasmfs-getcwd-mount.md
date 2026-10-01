# WasmFS: `getcwd()` drops the name of a mount point in a memory directory

**Draft: do not post as a new issue.** This is already reported as
[#18112](https://github.com/emscripten-core/emscripten/issues/18112) ("WasmFS:
Current directory ignores custom backend", open since 2022). A fix is open as
[#23756](https://github.com/emscripten-core/emscripten/pull/23756) ("Fix
retrieval of mounted directory names"), stalled since March 2025 on whether the
fix belongs in the backends. On #24141 ("getcwd returns incorrect answer using
OPFS with WASMFS"), a maintainer asked whether it duplicates #18112. Post the
text below as a **comment on #18112**. It answers the open question on #23756,
so linking to it from there would help too.

## Comment for #18112

---

This still reproduces on 6.0.9. As the `wasmfs_mounted_cwd.c` test in #23756
already shows, it needs nothing but the memory backend: any directory created
with `wasmfs_create_directory()` under the (memory) root loses its name in
`getcwd()`. The test case below is the same idea with a subdirectory added,
which shows the `//sub` form too.

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

**Test case** (`getcwd_mount.c`):

```c
#include <emscripten/wasmfs.h>
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>

static void show(const char *dir) {
  char buf[256];
  if (chdir(dir) != 0) {
    perror("chdir");
    return;
  }
  printf("chdir(\"%s\") -> getcwd() = \"%s\"\n", dir,
         getcwd(buf, sizeof buf) ? buf : "(error)");
}

int main(void) {
  /* A directory backed by a second memory backend: a mount point in the
     root's memory directory. */
  wasmfs_create_directory("/mnt", 0777, wasmfs_create_memory_backend());
  mkdir("/mnt/sub", 0777);
  /* An ordinary directory, for comparison. */
  mkdir("/plain", 0777);
  mkdir("/plain/sub", 0777);

  show("/plain/sub");
  show("/mnt");
  show("/mnt/sub");
  return 0;
}
```

**Failing command line in full** (the same at `-O2`):

```
$ emcc -O0 -sWASMFS getcwd_mount.c -o getcwd_mount.js && node getcwd_mount.js
chdir("/plain/sub") -> getcwd() = "/plain/sub"
chdir("/mnt") -> getcwd() = "/"
chdir("/mnt/sub") -> getcwd() = "//sub"
```

Expected `"/mnt"` and `"/mnt/sub"`.

<details>
<summary>Full compile and link output with <code>-v</code> appended (cache and scratch paths shortened)</summary>

```
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/clang -target wasm32-unknown-emscripten -fignore-exceptions -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr --sysroot=$EM_CACHE/sysroot -resource-dir=/nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter$EM_CACHE/sysroot/include -iwithsysroot/include/c++/v1 -Xclang -iwithsysroot/include/fakesdl -Xclang -iwithsysroot/include/compat -v -O0 -c getcwd_mount.c -o /tmp/emscripten_temp_9lvlc7x5/getcwd_mount.o
clang version 22.1.8
Target: wasm32-unknown-emscripten
Thread model: posix
InstalledDir: /nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin
 (in-process)
 "/nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin/clang-22" -cc1 -triple wasm32-unknown-emscripten -O0 -emit-obj -disable-free -clear-ast-before-backend -disable-llvm-verifier -discard-value-names -main-file-name getcwd_mount.c -mrelocation-model static -mframe-pointer=none -ffp-contract=on -fno-rounding-math -mconstructor-aliases -target-cpu generic -fvisibility=hidden -debugger-tuning=gdb -fdebug-compilation-dir=. -v -fcoverage-compilation-dir=. -resource-dir /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter $EM_CACHE/sysroot/include -iwithsysroot /include/c++/v1 -isysroot $EM_CACHE/sysroot -internal-isystem /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/include -internal-isystem $EM_CACHE/sysroot/include/wasm32-emscripten -internal-isystem $EM_CACHE/sysroot/include -ferror-limit 19 -fgnuc-version=4.2.1 -fskip-odr-check-in-gmf -fignore-exceptions -iwithsysroot/include/fakesdl -iwithsysroot/include/compat -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr -o /tmp/emscripten_temp_9lvlc7x5/getcwd_mount.o -x c getcwd_mount.c
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
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/wasm-ld -o getcwd_mount.wasm /tmp/tmp6s2p_n7slibemscripten_js_symbols.so -Bstatic --strip-debug --export=emscripten_stack_get_end --export=emscripten_stack_get_free --export=emscripten_stack_get_base --export=emscripten_stack_get_current --export=emscripten_stack_init --export=wasmfs_flush --export=_emscripten_stack_alloc --export=__wasm_call_ctors --export=_emscripten_stack_restore --export-if-defined=__start_em_asm --export-if-defined=__stop_em_asm --export-if-defined=__start_em_lib_deps --export-if-defined=__stop_em_lib_deps --export-if-defined=__start_em_js --export-if-defined=__stop_em_js --export-if-defined=main --export-if-defined=__main_argc_argv --export-if-defined=fflush --export-table -z stack-size=65536 --no-growable-memory --initial-heap=16777216 --no-entry --stack-first --table-base=1 /tmp/emscripten_temp_9lvlc7x5/getcwd_mount.o -L$EM_CACHE/sysroot/lib/wasm32-emscripten -L/nix/store/03iyrnrsxnbc64y6r62irmlbnbap5ya2-emscripten-6.0.9/share/emscripten/src/lib -lGL-getprocaddr -lal -lhtml5 -lstubs-debug -lnoexit -lc-debug -ldlmalloc-debug -lclang_rt.builtins -lc++-debug-noexcept -lc++abi-debug-noexcept -lsockets -lwasmfs_no_fs -lwasmfs-debug -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/llvm-objcopy getcwd_mount.wasm getcwd_mount.wasm '--remove-section=llvm.func_attr.annotate.*' --remove-section=producers --remove-section=name '--remove-section=.debug*'
```

</details>

**On the question in #23756 (fix the backends, or `Directory::Handle`?):**

- A mount point is never one of its parent backend's entries. `mountChild`
  puts it only in the parent's dcache, as `DCacheKind::Mount`
  ([syscalls.cpp#L658](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/syscalls.cpp#L658),
  [file.cpp#L43](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/file.cpp#L43)).
- So no backend can name it, including one that implements `getName` as
  `file.h` asks.
- `MemoryDirectory::getName` searches its own `entries`, correctly, and returns
  `""`
  ([memory_backend.cpp#L86-L95](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/backends/memory_backend.cpp#L86-L95)).
- `Directory::Handle::getName` returns that `""` without looking at the dcache,
  because the memory directory maintains file identity
  ([file.cpp#L209-L220](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/file.cpp#L209-L220)).
- Mounts are a `Directory::Handle`-level concept, so that seems the right place
  to resolve their names.

Checking the dcache first is enough. For identity-maintaining directories the
dcache holds only mounts, so the extra scan is short:

```diff
--- a/system/lib/wasmfs/file.cpp
+++ b/system/lib/wasmfs/file.cpp
@@ -207,15 +207,17 @@
 }
 
 std::string Directory::Handle::getName(std::shared_ptr<File> file) {
-  if (getDir()->maintainsFileIdentity()) {
-    return getDir()->getName(file);
-  }
+  // Mount points are always in the dcache, even in directories that maintain
+  // file identity themselves, so look there first.
   auto& dcache = getDir()->dcache;
   for (auto it = dcache.begin(); it != dcache.end(); ++it) {
     if (it->second.file == file) {
       return it->first;
     }
   }
+  if (getDir()->maintainsFileIdentity()) {
+    return getDir()->getName(file);
+  }
   return "";
 }
 
```

With this applied to 6.0.9, the test case prints:

```
chdir("/plain/sub") -> getcwd() = "/plain/sub"
chdir("/mnt") -> getcwd() = "/mnt"
chdir("/mnt/sub") -> getcwd() = "/mnt/sub"
```

#23756 gets the same result by falling back to the dcache when the backend
returns `""`. Either way works. The dcache-first order just doesn't depend on
the backend returning `""` for a file it doesn't know.

`getcwd()` isn't the only caller.
[emscripten.cpp#L47](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/emscripten.cpp#L47)
builds a `FILE*`'s path the same way, and the fix covers both.

---

## Notes for the user

- **Why it matters to us.** The runtime mounts OPFS at `/engines/<name>/` inside
  the memory root, so `getcwd()` there returns `/engines//…`. Under Node,
  `modules/toolchain/node-host-fs.c` avoids it by rooting WasmFS in the Node
  backend.
- **FAQ.** The FAQ doesn't mention WasmFS or `getcwd`. The File System API page
  calls WasmFS "Stable, but not yet feature-complete with the old FS". That
  doesn't make wrong `getcwd()` results intended. As the FAQ suggests, the case
  was run at `-O0` and `-O2` (identical). The test suite already skips
  `test_unistd_unlink` under WasmFS+NODEFS for #18112
  (`test/test_core.py:6257`).
- **bug_reports.rst.** The source, `emcc -v`, the symptoms and a tested fix are
  included. Bitcode is left out because the fault is in `libwasmfs`, not the
  test. The guide prefers a PR. #23756 already exists, so the comment offers the
  analysis rather than a competing PR. Alternatively, offer to take over #23756
  if its author has gone quiet.
- **Credit.** #23756 already has a memory-backend-only reproduction
  (`test/wasmfs/wasmfs_mounted_cwd.c`). The comment credits it, not ours, as
  the minimal case.
- **Duplicate search.** "wasmfs getcwd", "wasmfs getcwd mount", "wasmfs mount
  getName", "getcwd mounted directory", "getcwd empty name", "getcwd opfs",
  "WASMFS chdir" and "getcwd", plus a scan of all open issues and PRs matching
  "wasmfs", turned up #18112, #24141 and #23756. Nothing else is close.
- **Tip-of-tree.** Checked read-only through the GitHub API on 2026-09-30:
  `file.cpp`, `file.h`, `memory_backend.cpp` and `emscripten.cpp` are unchanged
  between 6.0.9 and `main` (2151200, 139 commits later). `syscalls.cpp` changed
  only in `fdatasync`'s error sign (#27806) and `utimensat`'s timestamp
  rounding; the cited `getcwd` code is unchanged, two lines further down. The
  latest release, 6.0.10 (tagged 2026-09-18), matches. The conclusion comes from
  the diff; `main` wasn't rebuilt. #18112 and #23756 were open on 2026-09-30.
- ibus-web carries this fix as `modules/emscripten/patches/0002-wasmfs-getcwd-mount.patch`.
