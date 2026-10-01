# WasmFS: backend failures to create a file or directory are reported as `EIO`

**Draft: new issue (low priority).** No existing issue covers it. The source
already admits the gap with a TODO at each site, so this is more a request to
track it than a bug report. Consider skipping it, or filing it only together
with the other Node backend reports.

## Issue title

WasmFS: mkdir()/open(O_CREAT) report EIO for any backend failure (e.g. EACCES from the Node backend)

## Issue body

---

When a backend fails to create a file or directory, WasmFS returns `EIO`
whatever the cause. With the Node backend, a host `EACCES` (or `EROFS`,
`ENOSPC`, `EDQUOT`, …) comes back as "I/O error". Callers that handle
`EACCES`/`EEXIST`/`ENOSPC` specially can't tell what happened.

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

**Test case** (`node_create_eio.c`; `argv[1]` is a host directory the
non-root user can't write to):

```c
#include <emscripten/wasmfs.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

int main(int argc, char **argv) {
  /* argv[1]: a host directory this (non-root) user cannot write to, mounted
     at /host. */
  wasmfs_create_directory("/host", 0777, wasmfs_create_node_backend(argv[1]));

  errno = 0;
  int r = mkdir("/host/dir", 0777);
  printf("mkdir = %d (%s)\n", r, r < 0 ? strerror(errno) : "no error");
  errno = 0;
  int fd = open("/host/file", O_CREAT | O_WRONLY, 0644);
  printf("open(O_CREAT) = %d (%s)\n", fd, fd < 0 ? strerror(errno) : "no error");
  return 0;
}
```

**Failing command line in full** (the same at `-O2`):

```
$ emcc -O0 -sWASMFS node_create_eio.c -o node_create_eio.js && mkdir -m 0555 host && id -u && node node_create_eio.js "$PWD/host"
1000
mkdir = -1 (I/O error)
open(O_CREAT) = -1 (I/O error)
```

Expected `EACCES` for both, which is what the host returned.

WasmFS's own permission check doesn't catch this. The mount point's mode is the
`0777` given to `wasmfs_create_directory`, not the host's `0555`. The same
happens for files in host directories owned by another user, since WasmFS
checks owner bits only.

<details>
<summary>Full compile and link output with <code>-v</code> appended (cache and scratch paths shortened)</summary>

```
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/clang -target wasm32-unknown-emscripten -fignore-exceptions -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr --sysroot=$EM_CACHE/sysroot -resource-dir=/nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter$EM_CACHE/sysroot/include -iwithsysroot/include/c++/v1 -Xclang -iwithsysroot/include/fakesdl -Xclang -iwithsysroot/include/compat -v -O0 -c node_create_eio.c -o /tmp/emscripten_temp_c_mnl45n/node_create_eio.o
clang version 22.1.8
Target: wasm32-unknown-emscripten
Thread model: posix
InstalledDir: /nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin
 (in-process)
 "/nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin/clang-22" -cc1 -triple wasm32-unknown-emscripten -O0 -emit-obj -disable-free -clear-ast-before-backend -disable-llvm-verifier -discard-value-names -main-file-name node_create_eio.c -mrelocation-model static -mframe-pointer=none -ffp-contract=on -fno-rounding-math -mconstructor-aliases -target-cpu generic -fvisibility=hidden -debugger-tuning=gdb -fdebug-compilation-dir=. -v -fcoverage-compilation-dir=. -resource-dir /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter $EM_CACHE/sysroot/include -iwithsysroot /include/c++/v1 -isysroot $EM_CACHE/sysroot -internal-isystem /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/include -internal-isystem $EM_CACHE/sysroot/include/wasm32-emscripten -internal-isystem $EM_CACHE/sysroot/include -ferror-limit 19 -fgnuc-version=4.2.1 -fskip-odr-check-in-gmf -fignore-exceptions -iwithsysroot/include/fakesdl -iwithsysroot/include/compat -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr -o /tmp/emscripten_temp_c_mnl45n/node_create_eio.o -x c node_create_eio.c
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
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/wasm-ld -o node_create_eio.wasm /tmp/tmpqts1cufjlibemscripten_js_symbols.so -Bstatic --strip-debug --export=emscripten_stack_get_end --export=emscripten_stack_get_free --export=emscripten_stack_get_base --export=emscripten_stack_get_current --export=emscripten_stack_init --export=wasmfs_flush --export=_emscripten_stack_alloc --export=__wasm_call_ctors --export=_emscripten_stack_restore --export-if-defined=__start_em_asm --export-if-defined=__stop_em_asm --export-if-defined=__start_em_lib_deps --export-if-defined=__stop_em_lib_deps --export-if-defined=__start_em_js --export-if-defined=__stop_em_js --export-if-defined=main --export-if-defined=__main_argc_argv --export-if-defined=fflush --export-table -z stack-size=65536 --no-growable-memory --initial-heap=16777216 --no-entry --stack-first --table-base=1 /tmp/emscripten_temp_c_mnl45n/node_create_eio.o -L$EM_CACHE/sysroot/lib/wasm32-emscripten -L/nix/store/03iyrnrsxnbc64y6r62irmlbnbap5ya2-emscripten-6.0.9/share/emscripten/src/lib -lGL-getprocaddr -lal -lhtml5 -lstubs-debug -lnoexit -lc-debug -ldlmalloc-debug -lclang_rt.builtins -lc++-debug-noexcept -lc++abi-debug-noexcept -lsockets -lwasmfs_no_fs -lwasmfs-debug -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/llvm-objcopy node_create_eio.wasm node_create_eio.wasm '--remove-section=llvm.func_attr.annotate.*' --remove-section=producers --remove-section=name '--remove-section=.debug*'
```

</details>

**Where:**
- `doOpen` and `doMkdir` turn a null result from the backend's
  `insertDataFile`/`insertDirectory` (or `createFile`/`createDirectory`) into
  `-EIO`, under `// TODO Receive a specific error code, and report it here`
  ([syscalls.cpp#L480-L493](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/syscalls.cpp#L480-L493),
  [#L645-L657](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/syscalls.cpp#L645-L657)).
- The Node backend has the host's errno in hand and drops it
  ([node_backend.cpp#L220-L236](https://github.com/emscripten-core/emscripten/blob/6.0.9/system/lib/wasmfs/backends/node_backend.cpp#L220-L236)).

**Possible fix:** let the `Directory` insert functions (and `Backend::create*`)
return an error code alongside the file, the way `getEntries` returns
`MaybeEntries`. Have the Node backend pass the host errno through. That changes
the backend interface, so we haven't written it.

---

## Notes for the user

- **FAQ.** Nothing in the FAQ covers it. Run at `-O0` and `-O2`, with the same
  result. The TODOs show the maintainers know. Whether a tracking issue is
  welcome is a judgement call; `bug_reports.rst` doesn't say.
- **bug_reports.rst.** The source, `emcc -v` and the symptoms are included. The
  proposed solution is a design sketch, not a tested patch: it changes the
  backend interface.
- **Test needs a non-root user.** Root would create the files.
- **Overlap with other drafts.** For `open(O_CREAT)`, fixing #18033 (see
  `emscripten-wasmfs-create-permission.md`) makes WasmFS answer `EACCES` itself
  whenever its idea of the directory's mode is right. This report covers the
  rest: mount points, other owners and non-permission errors.
- **Duplicate search.** "wasmfs EIO", "wasmfs I/O error", "wasmfs mkdir EIO",
  "Receive a specific error code", "wasmfs node backend" and "EACCES", plus a
  scan of all open "wasmfs" issues, turned up #17773 ("WasmFS: Error handling
  in OPFS backend", closed) and nothing about creation errors.
- **Why it matters to us.** GLib's `/fileutils/mkdir-with-parents` expects
  `EACCES` creating under `/usr` in the build sandbox. It got `EIO` until
  `modules/toolchain/node-host-fs.c` started `chmod`ing the WasmFS root to the
  host's mode.
- **Not verified on tip-of-tree or emsdk's latest release.** The build is
  nixpkgs' 6.0.9 with LLVM 22.1.8.
