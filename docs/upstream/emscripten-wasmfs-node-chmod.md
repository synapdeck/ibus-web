# WasmFS Node backend: `chmod()` (and `utimensat()`) never reach the host

**Draft: new issue.** No existing issue covers it.

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

**Possible fix:** give `File` a virtual `setMode` (and `setTimes`) hook that
backends can override and that may fail. The Node backend would implement it
with `fs.chmodSync`/`fs.utimesSync` (or the `f*` variants when the file is
open). The memory backend keeps the current behaviour. We haven't written this,
since it touches the backend API.

---

## Notes for the user

- **FAQ and docs.** The FAQ doesn't cover the WasmFS Node backend. The File
  System API page says WasmFS is "not yet feature-complete with the old FS",
  which arguably covers this. But nothing documents that metadata changes stay
  in memory, and NODEFS/NODERAWFS do pass them through. So this reads as a
  missing feature worth an issue, not a bug report against documented
  behaviour. Run at `-O0` and `-O2`, with the same result.
- **bug_reports.rst.** The source, `emcc -v` and the symptoms are included. The
  proposed solution is a design sketch, not a tested patch: it changes the
  backend interface, which the maintainers will want to shape.
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
  the next `g_creat()` there failed. `modules/toolchain/node-host-fs.c` relies
  on the same quirk on purpose: it `chmod`s the WasmFS root to the host's mode,
  knowing only WasmFS's record changes. If upstream fixes this, that `chmod`
  will start changing the host's `/`, or fail.
- **Not verified on tip-of-tree or emsdk's latest release.** The build is
  nixpkgs' 6.0.9 with LLVM 22.1.8.
