# `-sNODERAWFS`: `fstat()` on fds 0–2 throws a TypeError

**Draft: do not post.** This is already reported and fixed upstream:
[#27628](https://github.com/emscripten-core/emscripten/issues/27628) ("`fstat` on stdin/stdout/stderr stream crashes
with NODERAWFS", closed as completed on 2026-09-01) was fixed by
[#27632](https://github.com/emscripten-core/emscripten/pull/27632) ("Fix fstat on stdio streams under NODERAWFS", merged
2026-09-01). #27632 gives the standard streams a synthetic node and adds `test_fs_fstat_stdio`, which covers fds 0–2 on
every file system. **It's fixed in 6.0.10** (tagged 2026-09-18), whose `libnoderawfs.js` has #27632's
`createStandardStreams`. Emscripten 6.0.9 as packaged by nixpkgs predates the fix. Nothing needs to go upstream. When
nixpkgs moves to 6.0.10 or later, re-run the reproduction below to confirm.

Checked against `main` 5977ecc (2026-10-02): patch 0001 reverse-applies cleanly there (`git apply -R --check`), so
`main` has the same `libnoderawfs.js` change and nothing more is needed. Keep 0001 until nixpkgs packages 6.0.10 or
later.

The rest of this file records what we saw, so the check is quick.

## Reproduction (6.0.9)

```
emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 6.0.9-git
clang version 22.1.8
Target: wasm32-unknown-emscripten
Thread model: posix
InstalledDir: /nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin
```

`fstat_stdio.c`:

```c
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>

int main(void) {
  for (int fd = 0; fd < 3; fd++) {
    struct stat st;
    errno = 0;
    int r = fstat(fd, &st);
    printf("fstat(%d) = %d errno=%d mode=%o\n", fd, r, r ? errno : 0,
           r ? 0 : (unsigned)(st.st_mode & S_IFMT));
    fflush(stdout);
  }
  return 0;
}
```

```
$ emcc -O0 -sNODERAWFS fstat_stdio.c -o fstat_stdio.js && node fstat_stdio.js < /dev/null
fstat_stdio.js:2046
        var getattr = stream.stream_ops?.getattr ?? stream.node.node_ops?.getattr;
                                                                ^

TypeError: Cannot read properties of undefined (reading 'node_ops')
    at fstat (fstat_stdio.js:2046:65)
    at Object.fstat (fstat_stdio.js:4235:20)
    at ___syscall_fstat64 (fstat_stdio.js:4086:41)
    at wasm://wasm/c85ab01e:wasm-function[11]:0x522
    at wasm://wasm/c85ab01e:wasm-function[10]:0x4f4
    at wasm://wasm/c85ab01e:wasm-function[6]:0x2f7
    at wasm://wasm/c85ab01e:wasm-function[7]:0x3b3
    at fstat_stdio.js:604:12
    at callMain (fstat_stdio.js:4825:15)
    at run (fstat_stdio.js:4875:22)

Node.js v24.20.0
[exit status 1]
```

It is the same with stdin from a regular file or a pipe:

```
$ echo hi | node fstat_stdio.js
fstat_stdio.js:2046
        var getattr = stream.stream_ops?.getattr ?? stream.node.node_ops?.getattr;
                                                                ^

TypeError: Cannot read properties of undefined (reading 'node_ops')
    at fstat (fstat_stdio.js:2046:65)
    at Object.fstat (fstat_stdio.js:4235:20)
    at ___syscall_fstat64 (fstat_stdio.js:4086:41)
    at wasm://wasm/c85ab01e:wasm-function[11]:0x522
    at wasm://wasm/c85ab01e:wasm-function[10]:0x4f4
    at wasm://wasm/c85ab01e:wasm-function[6]:0x2f7
    at wasm://wasm/c85ab01e:wasm-function[7]:0x3b3
    at fstat_stdio.js:604:12
    at callMain (fstat_stdio.js:4825:15)
    at run (fstat_stdio.js:4875:22)

Node.js v24.20.0
[exit status 1]
```

Without `-sNODERAWFS`, or with `-sWASMFS`, all three calls succeed (the browser never hits this):

```
$ emcc -O0 fstat_stdio.c -o fstat_stdio.js && node fstat_stdio.js < /dev/null
fstat(0) = 0 errno=0 mode=20000
fstat(1) = 0 errno=0 mode=20000
fstat(2) = 0 errno=0 mode=20000
$ emcc -O0 -sWASMFS fstat_stdio.c -o fstat_stdio.js && node fstat_stdio.js < /dev/null
fstat(0) = 0 errno=0 mode=20000
fstat(1) = 0 errno=0 mode=20000
fstat(2) = 0 errno=0 mode=20000
```

<details>
<summary>Full compile and link output with <code>-v</code> appended (cache and scratch paths shortened)</summary>

```
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/clang -target wasm32-unknown-emscripten -fignore-exceptions -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr --sysroot=$EM_CACHE/sysroot -resource-dir=/nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter$EM_CACHE/sysroot/include -iwithsysroot/include/c++/v1 -Xclang -iwithsysroot/include/fakesdl -Xclang -iwithsysroot/include/compat -v -O0 -c fstat_stdio.c -o /tmp/emscripten_temp_0q23g6cs/fstat_stdio.o
clang version 22.1.8
Target: wasm32-unknown-emscripten
Thread model: posix
InstalledDir: /nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin
 (in-process)
 "/nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin/clang-22" -cc1 -triple wasm32-unknown-emscripten -O0 -emit-obj -disable-free -clear-ast-before-backend -disable-llvm-verifier -discard-value-names -main-file-name fstat_stdio.c -mrelocation-model static -mframe-pointer=none -ffp-contract=on -fno-rounding-math -mconstructor-aliases -target-cpu generic -fvisibility=hidden -debugger-tuning=gdb -fdebug-compilation-dir=. -v -fcoverage-compilation-dir=. -resource-dir /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/ -idirafter $EM_CACHE/sysroot/include -iwithsysroot /include/c++/v1 -isysroot $EM_CACHE/sysroot -internal-isystem /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/lib/clang/22/include -internal-isystem $EM_CACHE/sysroot/include/wasm32-emscripten -internal-isystem $EM_CACHE/sysroot/include -ferror-limit 19 -fgnuc-version=4.2.1 -fskip-odr-check-in-gmf -fignore-exceptions -iwithsysroot/include/fakesdl -iwithsysroot/include/compat -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr -o /tmp/emscripten_temp_0q23g6cs/fstat_stdio.o -x c fstat_stdio.c
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
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/wasm-ld -o fstat_stdio.wasm /tmp/tmpa0qfkxcrlibemscripten_js_symbols.so -Bstatic --strip-debug --export=emscripten_stack_get_end --export=emscripten_stack_get_free --export=emscripten_stack_get_base --export=emscripten_stack_get_current --export=emscripten_stack_init --export=_emscripten_stack_alloc --export=__wasm_call_ctors --export=_emscripten_stack_restore --export-if-defined=__start_em_asm --export-if-defined=__stop_em_asm --export-if-defined=__start_em_lib_deps --export-if-defined=__stop_em_lib_deps --export-if-defined=__start_em_js --export-if-defined=__stop_em_js --export-if-defined=main --export-if-defined=__main_argc_argv --export-if-defined=fflush --export-table -z stack-size=65536 --no-growable-memory --initial-heap=16777216 --no-entry --stack-first --table-base=1 /tmp/emscripten_temp_0q23g6cs/fstat_stdio.o -L$EM_CACHE/sysroot/lib/wasm32-emscripten -L/nix/store/03iyrnrsxnbc64y6r62irmlbnbap5ya2-emscripten-6.0.9/share/emscripten/src/lib -lGL-getprocaddr -lal -lhtml5 -lstubs-debug -lnoexit -lc-debug -ldlmalloc-debug -lclang_rt.builtins -lsockets -mllvm -combiner-global-alias-analysis=false -mllvm -enable-emscripten-sjlj -mllvm -disable-lsr
 /nix/store/l05jw62495v8gcd0f2r01klky8i5k52i-emscripten-llvm-6.0.9/bin/llvm-objcopy fstat_stdio.wasm fstat_stdio.wasm '--remove-section=llvm.func_attr.annotate.*' --remove-section=producers --remove-section=name '--remove-section=.debug*'
```

</details>

**Cause in 6.0.9:** NODERAWFS's `createStandardStreams` creates fds 0–2 with no `node`
([libnoderawfs.js#L67-L73](https://github.com/emscripten-core/emscripten/blob/6.0.9/src/lib/libnoderawfs.js#L67-L73)).
Its `fstat` then reads `stream.node.node_ops`
([libnoderawfs.js#L112](https://github.com/emscripten-core/emscripten/blob/6.0.9/src/lib/libnoderawfs.js#L112)). The
getattr dispatch came in with #27305; #27632 describes the regression the same way. Changing `stream.node.node_ops` to
`stream.node?.node_ops` in the generated JavaScript made all three calls succeed, reporting the host's types
(`/dev/null` as a character device, a pipe as a FIFO). #27632 fixes it the other way, by giving the streams a node.

## Evidence

- **FAQ / bug_reports.rst.** The FAQ doesn't mention NODERAWFS or `fstat`. The guide's checklist doesn't apply, since
  there is nothing to file.
- **Duplicate search.** "NODERAWFS fstat", "NODERAWFS stdin", "node_ops undefined", the exact TypeError text, "fstat
  stdin NODERAWFS" and "NODERAWFS fstat stdout" turned up #27628 and its fix #27632, plus #27305 (the change that
  introduced the dereference).
- **Where we hit it.** GLib's `/mainloop/blocked_child_sources` hit this while the tests ran on NODERAWFS. They run on
  WasmFS now, where `fstat(0)` works. We haven't checked whether the GLib tools, which still link with NODERAWFS, ever
  `fstat` a standard stream.
- **Tip-of-tree.** Checked read-only through the GitHub API on 2026-09-30: both 6.0.10 and `main` (2151200) carry
  #27632's change to `libnoderawfs.js`. That it fixes our case is inferred from the code and #27632's test; neither was
  built here.
- ibus-web carries this fix as `modules/emscripten/patches/0001-noderawfs-fstat-stdio.patch`.
