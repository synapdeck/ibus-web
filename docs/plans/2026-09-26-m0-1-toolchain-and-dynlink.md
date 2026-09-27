# M0.1: Toolchain and dynamic-linking spike — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Nix build foundation for ibus-web and answer the spec's
risk R3: can a threaded Emscripten main module load side modules at run time,
run side-module code on pool threads, and handle C++ exceptions?

**Architecture:** A flake pins nixpkgs. `nix/toolchain` builds a prebuilt
Emscripten library cache for this project's flags and a `wasmStdenv` that turns
nixpkgs recipes into WASM builds (spec §10.2–10.3). libhangul is the first
recipe converted. A spike under `tests/spikes/dynlink` links a main module and
five side modules and runs them under Node as a flake check.

**Tech stack:** Nix flakes, nixpkgs Emscripten 6.0.9 (LLVM 22.1.8), Node 24,
C/C++, autotools (through nixpkgs' libhangul recipe).

**Scope:** First slice of spec milestone M0. Not in this plan: the GLib patch
forward-port, the Meson and CMake paths of `wasmStdenv`, `libibus-web`, the
Worker wait loop (R2) and CI workflows. Each gets its own plan.

## Global constraints

- nixpkgs revision: `8ce4ef6cb6f871616146b9fe26d2a5ae594e94fe` (2026-09-10), locked through `flake.lock`.
- Emscripten comes from nixpkgs (6.0.9 at that revision). No compiler patches; never `-sEMULATE_FUNCTION_POINTER_CASTS`.
- Every WASM object is compiled with `-fPIC -pthread -fwasm-exceptions`.
- System: `x86_64-linux` only in this plan.
- Everything builds through the flake; `nix flake check` must pass at the end of every task.
- Our code in this plan is licensed MIT OR Apache-2.0.
- Comments explain why, not what, and never refer to other files, this plan or its history.
- Flakes only see files git tracks: `git add` new files before any `nix build` or `nix flake check`.

## File map

| Path | Responsibility |
|---|---|
| `flake.nix`, `flake.lock` | Inputs and top-level outputs |
| `nix/default.nix` | Assembles packages, checks and the dev shell |
| `nix/checks/default.nix` | Flake checks |
| `nix/toolchain/default.nix` | `commonFlags`, `testMainFlags`, `emscriptenCache`, `emscriptenCacheHook`, `wasmStdenv` |
| `nix/toolchain/probes/*` | Programs whose compilation fills the library cache |
| `nix/toolchain/emscripten-cache-hook.sh` | Per-build writable cache with a read-only library directory |
| `nix/toolchain/wasm-stdenv.nix`, `nix/toolchain/wasm-build-hook.sh` | Emscripten stdenv for nixpkgs recipes |
| `nix/overrides/default.nix`, `nix/overrides/libhangul.nix` | WASM overrides of nixpkgs recipes |
| `nix/overrides/tests/libhangul-test.c` | Install check for libhangul |
| `tests/spikes/dynlink/*` | Dynamic-linking spike sources and expected output |
| `nix/checks/dynlink-spike.nix` | Builds and runs the spike |
| `docs/spikes/2026-09-26-dynlink.md` | Spike findings |

---

### Task 1: Flake skeleton with a formatting check

**Files:**
- Create: `flake.nix`, `nix/default.nix`, `nix/checks/default.nix`, `.gitignore`, `LICENSE-MIT`, `LICENSE-APACHE`
- Generated: `flake.lock`

**Interfaces:**
- Produces: `nix/default.nix` is a function `{ pkgs, src }` returning `{ packages, checks, devShell }`. `nix/checks/default.nix` is a function returning an attrset of check derivations. Later tasks extend both.

- [ ] **Step 1: Confirm there is nothing to check yet**

Run: `cd ~/Development/ibus-web && nix flake check`
Expected: FAIL with an error that `flake.nix` does not exist.

- [ ] **Step 2: Write `flake.nix`**

```nix
{
  description = "ibus-web: IBus engines running in the browser";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      ibusWeb = import ./nix {
        inherit pkgs;
        src = self;
      };
    in
    {
      packages.${system} = ibusWeb.packages;
      checks.${system} = ibusWeb.checks;
      devShells.${system}.default = ibusWeb.devShell;
      formatter.${system} = pkgs.nixfmt;
    };
}
```

- [ ] **Step 3: Write `nix/default.nix`**

```nix
{ pkgs, src }:
let
  checks = import ./checks { inherit pkgs src; };
in
{
  packages = { };
  inherit checks;
  devShell = pkgs.mkShell {
    packages = [ pkgs.nixfmt ];
  };
}
```

- [ ] **Step 4: Write `nix/checks/default.nix`**

```nix
{ pkgs, src }:
{
  format = pkgs.runCommand "ibus-web-format-check" { nativeBuildInputs = [ pkgs.nixfmt ]; } ''
    cd ${src}
    nixfmt --check $(find . -name '*.nix')
    touch $out
  '';
}
```

- [ ] **Step 5: Write `.gitignore`**

```gitignore
result
result-*
.emcache/
```

- [ ] **Step 6: Add license texts**

Write `LICENSE-MIT`:

```text
MIT License

Copyright (c) 2026 Alexis Williams

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Fetch the Apache license text verbatim:

Run: `curl -fsSL https://www.apache.org/licenses/LICENSE-2.0.txt -o LICENSE-APACHE && head -3 LICENSE-APACHE`
Expected: the first lines read `Apache License` / `Version 2.0, January 2004`.

- [ ] **Step 7: Lock nixpkgs to the spec's revision**

Run: `git add -A && nix flake lock --override-input nixpkgs github:NixOS/nixpkgs/8ce4ef6cb6f871616146b9fe26d2a5ae594e94fe`
Expected: `flake.lock` is created and names revision `8ce4ef6cb6f871616146b9fe26d2a5ae594e94fe`.

Run: `grep -c 8ce4ef6cb6f871616146b9fe26d2a5ae594e94fe flake.lock`
Expected: `1`

- [ ] **Step 8: Run the checks**

Run: `nix flake check -L`
Expected: PASS. If `nixfmt --check` reports a file, run `nix fmt` and re-run.

- [ ] **Step 9: Commit**

```bash
git add flake.nix flake.lock nix/default.nix nix/checks/default.nix .gitignore LICENSE-MIT LICENSE-APACHE
git commit -m "Add flake skeleton with formatting check"
```

---

### Task 2: Prebuilt Emscripten library cache

nixpkgs' Emscripten ships libraries only for non-PIC variants, so without this
every PIC build would compile libc and libc++ again (spec §10.3).

**Files:**
- Create: `nix/toolchain/default.nix`, `nix/toolchain/emscripten-cache-hook.sh`, `nix/toolchain/probes/probe.c`, `nix/toolchain/probes/probe.cpp`, `nix/toolchain/probes/probe_side.c`, `nix/toolchain/probes/probe_side.cpp`
- Modify: `nix/default.nix`, `nix/checks/default.nix`

**Interfaces:**
- Consumes: Task 1's `nix/default.nix` and `nix/checks/default.nix`.
- Produces: `nix/toolchain/default.nix` is a function `{ pkgs }` returning:
  - `commonFlags` (string): `"-fPIC -pthread -fwasm-exceptions"`
  - `testMainFlags` (string): link flags for Node-run test main modules, identical to a combination the cache was built for
  - `emscriptenCache` (derivation): an Emscripten cache directory
  - `emscriptenCacheHook` (setup hook): sets `EM_CACHE` to a writable per-build copy whose `sysroot/lib` is read-only, and sets `HOME` when it is the sandbox placeholder

- [ ] **Step 1: Write the probe programs**

`nix/toolchain/probes/probe.c`:

```c
#include <pthread.h>
#include <stdio.h>

static void *echo(void *arg) { return arg; }

int main(void) {
  pthread_t thread;
  void *result = NULL;
  int value = 7;

  if (pthread_create(&thread, NULL, echo, &value) != 0) return 1;
  if (pthread_join(thread, &result) != 0) return 2;

  FILE *f = fopen("/tmp/probe.txt", "w");
  if (f != NULL) {
    fputs("ok", f);
    fclose(f);
  }

  printf("probe %d\n", *(int *)result);
  return 0;
}
```

`nix/toolchain/probes/probe.cpp`:

```cpp
#include <cstdio>
#include <stdexcept>
#include <string>
#include <vector>

int main() {
  std::vector<std::string> items{"a", "b"};
  try {
    throw std::runtime_error("probe");
  } catch (const std::exception &e) {
    std::printf("%s %zu\n", e.what(), items.size());
  }
  return 0;
}
```

`nix/toolchain/probes/probe_side.c`:

```c
int probe(void) { return 0; }
```

`nix/toolchain/probes/probe_side.cpp`:

```cpp
#include <stdexcept>

extern "C" int probe() {
  try {
    throw std::runtime_error("side");
  } catch (const std::exception &) {
    return 0;
  }
}
```

- [ ] **Step 2: Write the cache hook**

`nix/toolchain/emscripten-cache-hook.sh`:

```bash
# Each build gets a private copy of the prebuilt cache. The library directory
# is made read-only, so a build that needs a variant the cache lacks fails
# with "Permission denied" instead of silently compiling libc again.
emscriptenCacheSetup() {
  export EM_CACHE="$NIX_BUILD_TOP/emscripten-cache"
  if [ ! -d "$EM_CACHE" ]; then
    cp -r --no-preserve=mode @cache@ "$EM_CACHE"
    chmod -R a-w "$EM_CACHE/sysroot/lib"
  fi
  # Emscripten writes to $HOME, which the sandbox points at a missing path.
  if [ "${HOME:-/homeless-shelter}" = /homeless-shelter ]; then
    export HOME="$NIX_BUILD_TOP"
  fi
}

emscriptenCacheSetup
```

- [ ] **Step 3: Write `nix/toolchain/default.nix`**

```nix
{ pkgs }:
let
  inherit (pkgs) emscripten;

  commonFlags = "-fPIC -pthread -fwasm-exceptions";

  # Link settings the cache is prepared for. Emscripten picks library
  # variants from link settings, so tests must link with one of these.
  mainLinkNode = "-sMAIN_MODULE=1 -sPTHREAD_POOL_SIZE=2 -sNODERAWFS=1 -sEXIT_RUNTIME=1";
  mainLinkWasmfs = "-sMAIN_MODULE=2 -sPTHREAD_POOL_SIZE=2 -sWASMFS=1 -sEXIT_RUNTIME=1";

  emscriptenCache = pkgs.stdenvNoCC.mkDerivation {
    pname = "emscripten-cache";
    inherit (emscripten) version;
    src = ./probes;
    nativeBuildInputs = [
      emscripten
      pkgs.nodejs
    ];

    buildPhase = ''
      runHook preBuild
      export HOME=$TMPDIR
      export EM_CACHE=$TMPDIR/cache
      cp -r --no-preserve=mode ${emscripten}/share/emscripten/cache $EM_CACHE

      for opt in -O0 -O2; do
        for link in "${mainLinkNode}" "${mainLinkWasmfs}"; do
          emcc $opt ${commonFlags} $link probe.c -o $TMPDIR/probe-c.js
          em++ $opt ${commonFlags} $link probe.cpp -o $TMPDIR/probe-cpp.js
        done
        emcc $opt ${commonFlags} -sSIDE_MODULE=1 probe_side.c -o $TMPDIR/probe-side.wasm
        em++ $opt ${commonFlags} -sSIDE_MODULE=1 probe_side.cpp -o $TMPDIR/probe-side-cpp.wasm
      done

      node $TMPDIR/probe-c.js
      node $TMPDIR/probe-cpp.js
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      rm -rf $EM_CACHE/build
      cp -r $EM_CACHE $out
      runHook postInstall
    '';
  };

  emscriptenCacheHook = pkgs.makeSetupHook {
    name = "emscripten-cache-hook";
    substitutions.cache = emscriptenCache;
  } ./emscripten-cache-hook.sh;
in
{
  inherit commonFlags emscriptenCache emscriptenCacheHook;
  testMainFlags = "-O2 ${mainLinkNode}";
}
```

- [ ] **Step 4: Expose the toolchain from `nix/default.nix`**

```nix
{ pkgs, src }:
let
  toolchain = import ./toolchain { inherit pkgs; };
  checks = import ./checks { inherit pkgs src toolchain; };
in
{
  packages = {
    inherit (toolchain) emscriptenCache;
  };
  inherit checks;
  devShell = pkgs.mkShell {
    packages = [
      pkgs.nixfmt
      pkgs.emscripten
      pkgs.nodejs
    ];
    # A writable cache in the checkout, seeded from the prebuilt one.
    shellHook = ''
      export EM_CACHE="$PWD/.emcache"
      if [ ! -d "$EM_CACHE" ]; then
        cp -r --no-preserve=mode ${toolchain.emscriptenCache} "$EM_CACHE"
      fi
    '';
  };
}
```

- [ ] **Step 5: Build the cache**

Run: `git add nix/toolchain nix/default.nix && nix build .#emscriptenCache -L`
Expected: the build log ends with `probe 7` and `probe 2`, and `ls result/sysroot/lib/wasm32-emscripten/pic` lists `libc-mt.a`, `libc++-mt-wasmexcept.a` and `libc++abi-mt-wasmexcept.a`.

- [ ] **Step 6: Write the failing cache check**

Replace `nix/checks/default.nix`:

```nix
{
  pkgs,
  src,
  toolchain,
}:
{
  format = pkgs.runCommand "ibus-web-format-check" { nativeBuildInputs = [ pkgs.nixfmt ]; } ''
    cd ${src}
    nixfmt --check $(find . -name '*.nix')
    touch $out
  '';

  # Probe programs must build from the cache alone, and a variant the cache
  # lacks must fail rather than be compiled.
  toolchain-cache =
    pkgs.runCommand "ibus-web-toolchain-cache-check"
      {
        nativeBuildInputs = [
          pkgs.emscripten
          pkgs.nodejs
          toolchain.emscriptenCacheHook
        ];
      }
      ''
        cp ${../toolchain/probes}/* .
        emcc ${toolchain.commonFlags} ${toolchain.testMainFlags} probe.c -o probe-c.js
        em++ ${toolchain.commonFlags} ${toolchain.testMainFlags} probe.cpp -o probe-cpp.js
        test "$(node probe-c.js)" = "probe 7"
        test "$(node probe-cpp.js)" = "probe 2"

        if emcc ${toolchain.commonFlags} ${toolchain.testMainFlags} -sMALLOC=mimalloc probe.c -o uncached.js 2> uncached.log; then
          echo "expected an uncached library variant to fail" >&2
          exit 1
        fi
        grep -q "Permission denied" uncached.log
        touch $out
      '';
}
```

- [ ] **Step 7: Run the checks**

Run: `nix flake check -L`
Expected: PASS for `format` and `toolchain-cache`.

If `toolchain-cache` fails on the first two compiles with `Permission denied`, the cache lacks a variant those links need. Read the library name from the error, add a probe compile to `emscriptenCache` that produces it, and re-run. If the `-sMALLOC=mimalloc` compile unexpectedly succeeds, `libmimalloc-mt` was built into the cache by a probe; pick another uncached setting (for example `-sMALLOC=emmalloc-debug`) and confirm it is missing with `ls result/sysroot/lib/wasm32-emscripten/pic`.

- [ ] **Step 8: Commit**

```bash
git add nix/toolchain nix/default.nix nix/checks/default.nix
git commit -m "Add prebuilt Emscripten library cache and cache check"
```

---

### Task 3: `wasmStdenv` and a WASM build of libhangul

**Files:**
- Create: `nix/toolchain/wasm-stdenv.nix`, `nix/toolchain/wasm-build-hook.sh`, `nix/overrides/default.nix`, `nix/overrides/libhangul.nix`, `nix/overrides/tests/libhangul-test.c`
- Modify: `nix/toolchain/default.nix`, `nix/default.nix`

**Interfaces:**
- Consumes: `commonFlags`, `testMainFlags`, `emscriptenCacheHook` from Task 2.
- Produces:
  - `toolchain.wasmStdenv`: a stdenv whose `mkDerivation` accepts native nixpkgs recipes (attrset or `finalAttrs` function) and builds them with Emscripten as static PIC libraries.
  - `nix/overrides/default.nix`: a function `{ pkgs, toolchain }` returning `{ libhangul-wasm }`.
  - `libhangul-wasm`: installs `lib/libhangul.a`, `include/hangul-1.0/hangul.h`, `lib/pkgconfig/libhangul.pc` and the Hanja data.

- [ ] **Step 1: Write the failing install check program**

`nix/overrides/tests/libhangul-test.c`:

```c
/* 2-set keys g, k, s compose to the syllable 한 (U+D55C). */
#include <hangul.h>
#include <stdio.h>

int main(void) {
  hangul_init(NULL);
  HangulInputContext *hic = hangul_ic_new("2");
  if (hic == NULL) {
    puts("hangul_ic_new failed");
    return 1;
  }

  hangul_ic_process(hic, 'g');
  hangul_ic_process(hic, 'k');
  hangul_ic_process(hic, 's');

  const ucschar *preedit = hangul_ic_get_preedit_string(hic);
  printf("preedit U+%04X\n", (unsigned)preedit[0]);
  int ok = preedit[0] == 0xD55C && preedit[1] == 0;

  hangul_ic_delete(hic);
  hangul_fini();
  return ok ? 0 : 1;
}
```

- [ ] **Step 2: Write the build hook**

`nix/toolchain/wasm-build-hook.sh`:

```bash
# Recipes written for the native stdenv build unchanged: every build system
# sees Emscripten's tools and this project's code-generation flags, and
# autotools configure scripts run through emconfigure.
export CC=emcc CXX=em++ AR=emar RANLIB=emranlib NM=@nm@
export CFLAGS="@commonFlags@ ${CFLAGS:-}"
export CXXFLAGS="@commonFlags@ ${CXXFLAGS:-}"
export LDFLAGS="-pthread ${LDFLAGS:-}"
# Configure-time test programs become JS and run under Node.
export EMCONFIGURE_JS=2

wasmConfigureSetup() {
  if [ -z "${configureScript:-}" ] && [ -x ./configure ]; then
    configureScript="emconfigure ./configure"
  fi
}
preConfigureHooks+=(wasmConfigureSetup)
```

- [ ] **Step 3: Write `nix/toolchain/wasm-stdenv.nix`**

```nix
{
  pkgs,
  commonFlags,
  emscriptenCacheHook,
}:
let
  inherit (pkgs) lib emscripten;

  wasmBuildHook = pkgs.makeSetupHook {
    name = "wasm-build-hook";
    substitutions = {
      inherit commonFlags;
      nm = "${emscripten.llvmEnv}/bin/llvm-nm";
    };
  } ./wasm-build-hook.sh;
in
pkgs.stdenv
// {
  mkDerivation =
    fnOrAttrs:
    pkgs.stdenv.mkDerivation (
      finalAttrs:
      let
        args = lib.toFunction fnOrAttrs finalAttrs;
      in
      args
      // {
        nativeBuildInputs = (args.nativeBuildInputs or [ ]) ++ [
          emscripten
          emscriptenCacheHook
          wasmBuildHook
          pkgs.nodejs
        ];
        # Side modules link libraries statically, so only .a files are wanted.
        configureFlags = (args.configureFlags or [ ]) ++ [
          "--host=wasm32-unknown-emscripten"
          "--enable-static"
          "--disable-shared"
        ];
        dontDisableStatic = true;
        dontStrip = true;
        dontPatchELF = true;
        doCheck = false;
      }
    );
}
```

- [ ] **Step 4: Export `wasmStdenv` from the toolchain**

In `nix/toolchain/default.nix`, replace the final attrset (after `in`) with:

```nix
{
  inherit commonFlags emscriptenCache emscriptenCacheHook;
  testMainFlags = "-O2 ${mainLinkNode}";
  wasmStdenv = import ./wasm-stdenv.nix {
    inherit pkgs commonFlags emscriptenCacheHook;
  };
}
```

- [ ] **Step 5: Write the libhangul override**

`nix/overrides/libhangul.nix`:

```nix
{ pkgs, toolchain }:
(pkgs.libhangul.override { stdenv = toolchain.wasmStdenv; }).overrideAttrs (old: {
  pname = "libhangul-wasm";
  configureFlags = old.configureFlags ++ [ "--disable-nls" ];
  # The command-line tool needs iconv and is not shipped; build only the
  # library and its data.
  makeFlags = (old.makeFlags or [ ]) ++ [ "SUBDIRS=hangul data" ];

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    emcc ${toolchain.commonFlags} ${toolchain.testMainFlags} \
      ${./tests/libhangul-test.c} \
      -I$out/include/hangul-1.0 $out/lib/libhangul.a \
      -o libhangul-test.js
    node libhangul-test.js
    runHook postInstallCheck
  '';
})
```

`nix/overrides/default.nix`:

```nix
{ pkgs, toolchain }:
{
  libhangul-wasm = import ./libhangul.nix { inherit pkgs toolchain; };
}
```

- [ ] **Step 6: Expose the override**

Replace `nix/default.nix`:

```nix
{ pkgs, src }:
let
  toolchain = import ./toolchain { inherit pkgs; };
  overrides = import ./overrides { inherit pkgs toolchain; };
  checks = import ./checks { inherit pkgs src toolchain; };
in
{
  packages = {
    inherit (toolchain) emscriptenCache;
    inherit (overrides) libhangul-wasm;
  };
  inherit checks;
  devShell = pkgs.mkShell {
    packages = [
      pkgs.nixfmt
      pkgs.emscripten
      pkgs.nodejs
    ];
    # A writable cache in the checkout, seeded from the prebuilt one.
    shellHook = ''
      export EM_CACHE="$PWD/.emcache"
      if [ ! -d "$EM_CACHE" ]; then
        cp -r --no-preserve=mode ${toolchain.emscriptenCache} "$EM_CACHE"
      fi
    '';
  };
}
```

- [ ] **Step 7: Build libhangul and run its install check**

Run: `git add nix && nix build .#libhangul-wasm -L`
Expected: the log shows `emconfigure ./configure ... --host=wasm32-unknown-emscripten --enable-static --disable-shared --disable-nls`, then `preedit U+D55C`, and the build succeeds.

Run: `ls result/lib result/include/hangul-1.0 result/share/libhangul/hanja`
Expected: `libhangul.a` (and `libhangul.la`, `pkgconfig/`), `hangul.h`, and `hanja.txt`.

If configure fails on `--host=wasm32-unknown-emscripten` ("Invalid configuration"), the generated `config.sub` is too old to know the triple; add `postAutoreconf = "cp ${pkgs.gnu-config}/config.sub .";` to the override and re-run. If `make` still enters `tools` or `po`, check that `makeFlags` reached the build (`nix log .#libhangul-wasm | grep SUBDIRS`).

- [ ] **Step 8: Run all checks**

Run: `nix flake check -L`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add nix/toolchain nix/overrides nix/default.nix
git commit -m "Add wasmStdenv and a WASM build of libhangul"
```

---

### Task 4: Dynamic-linking spike

Answers R3. A threaded main module loads five side modules at run time with
`dlopen`, after its thread pool already exists:

| Side module | What it shows |
|---|---|
| `side_basic` | Calling into a side module that uses main-module libc |
| `side_thread` | Side-module code running on a pool thread created before the `dlopen` |
| `side_cxx` | A C++ exception thrown and caught inside a side module |
| `side_throw` | A C++ exception thrown in a side module and caught in the main module |
| `side_hangul` | A static library (libhangul) linked into a side module, the shape of an engine |

**Files:**
- Create: `tests/spikes/dynlink/main.cpp`, `tests/spikes/dynlink/side_basic.c`, `tests/spikes/dynlink/side_thread.c`, `tests/spikes/dynlink/side_cxx.cpp`, `tests/spikes/dynlink/side_throw.cpp`, `tests/spikes/dynlink/side_hangul.c`, `tests/spikes/dynlink/expected.txt`, `nix/checks/dynlink-spike.nix`
- Modify: `nix/checks/default.nix`, `nix/default.nix`

**Interfaces:**
- Consumes: `commonFlags`, `testMainFlags`, `emscriptenCacheHook` (Task 2); `libhangul-wasm` (Task 3).
- Produces: flake check `dynlink-spike`. Every side module exports `int probe(void)`, returning 0 on success.

- [ ] **Step 1: Write the expected output**

`tests/spikes/dynlink/expected.txt`:

```text
PASS side_basic.wasm
PASS side_thread.wasm
PASS side_cxx.wasm
CAUGHT side_throw.wasm: thrown in side module
PASS side_hangul.wasm
```

- [ ] **Step 2: Write the main module**

`tests/spikes/dynlink/main.cpp`:

```cpp
// Loads each side module named on the command line and runs its probe.
#include <cstdio>
#include <cstring>
#include <dlfcn.h>
#include <stdexcept>

using Probe = int (*)();

static const char *basename_of(const char *path) {
  const char *slash = std::strrchr(path, '/');
  return slash ? slash + 1 : path;
}

int main(int argc, char **argv) {
  int failures = 0;
  for (int i = 1; i < argc; ++i) {
    const char *name = basename_of(argv[i]);
    void *handle = dlopen(argv[i], RTLD_NOW);
    if (handle == nullptr) {
      std::printf("FAIL %s: dlopen: %s\n", name, dlerror());
      ++failures;
      continue;
    }
    auto probe = reinterpret_cast<Probe>(dlsym(handle, "probe"));
    if (probe == nullptr) {
      std::printf("FAIL %s: dlsym: %s\n", name, dlerror());
      ++failures;
      continue;
    }
    try {
      int result = probe();
      if (result == 0) {
        std::printf("PASS %s\n", name);
      } else {
        std::printf("FAIL %s: probe returned %d\n", name, result);
        ++failures;
      }
    } catch (const std::exception &e) {
      std::printf("CAUGHT %s: %s\n", name, e.what());
    }
  }
  return failures;
}
```

- [ ] **Step 3: Write the side modules**

`tests/spikes/dynlink/side_basic.c`:

```c
#include <stdio.h>
#include <string.h>

int probe(void) {
  char buffer[16];
  snprintf(buffer, sizeof buffer, "%d", 40 + 2);
  return strcmp(buffer, "42") == 0 ? 0 : 1;
}
```

`tests/spikes/dynlink/side_thread.c`:

```c
#include <pthread.h>

static int result;

static void *double_it(void *arg) {
  result = *(int *)arg * 2;
  return NULL;
}

int probe(void) {
  pthread_t thread;
  int input = 21;
  if (pthread_create(&thread, NULL, double_it, &input) != 0) return 1;
  if (pthread_join(thread, NULL) != 0) return 2;
  return result == 42 ? 0 : 3;
}
```

`tests/spikes/dynlink/side_cxx.cpp`:

```cpp
#include <stdexcept>
#include <string>

extern "C" int probe() {
  try {
    throw std::runtime_error("inside");
  } catch (const std::runtime_error &e) {
    return std::string(e.what()) == "inside" ? 0 : 1;
  }
}
```

`tests/spikes/dynlink/side_throw.cpp`:

```cpp
#include <stdexcept>

extern "C" int probe() { throw std::runtime_error("thrown in side module"); }
```

`tests/spikes/dynlink/side_hangul.c`:

```c
#include <hangul.h>

int probe(void) {
  hangul_init(NULL);
  HangulInputContext *hic = hangul_ic_new("2");
  if (hic == NULL) return 1;

  hangul_ic_process(hic, 'g');
  hangul_ic_process(hic, 'k');
  hangul_ic_process(hic, 's');
  const ucschar *preedit = hangul_ic_get_preedit_string(hic);
  int ok = preedit[0] == 0xD55C && preedit[1] == 0;

  hangul_ic_delete(hic);
  hangul_fini();
  return ok ? 0 : 2;
}
```

- [ ] **Step 4: Write the spike check**

`nix/checks/dynlink-spike.nix`:

```nix
{
  pkgs,
  toolchain,
  libhangul-wasm,
}:
pkgs.stdenvNoCC.mkDerivation {
  name = "ibus-web-dynlink-spike";
  src = ../../tests/spikes/dynlink;
  nativeBuildInputs = [
    pkgs.emscripten
    pkgs.nodejs
    toolchain.emscriptenCacheHook
  ];

  buildPhase = ''
    runHook preBuild
    flags="${toolchain.commonFlags} -O2"
    em++ $flags ${toolchain.testMainFlags} main.cpp -o main.js
    emcc $flags -sSIDE_MODULE=1 side_basic.c -o side_basic.wasm
    emcc $flags -sSIDE_MODULE=1 side_thread.c -o side_thread.wasm
    em++ $flags -sSIDE_MODULE=1 side_cxx.cpp -o side_cxx.wasm
    em++ $flags -sSIDE_MODULE=1 side_throw.cpp -o side_throw.wasm
    emcc $flags -sSIDE_MODULE=1 side_hangul.c \
      -I${libhangul-wasm}/include/hangul-1.0 ${libhangul-wasm}/lib/libhangul.a \
      -o side_hangul.wasm
    runHook postBuild
  '';

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    node main.js $PWD/side_basic.wasm $PWD/side_thread.wasm $PWD/side_cxx.wasm \
      $PWD/side_throw.wasm $PWD/side_hangul.wasm > actual.txt
    cat actual.txt
    diff -u expected.txt actual.txt
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp actual.txt $out/
    runHook postInstall
  '';
}
```

- [ ] **Step 5: Register the check**

In `nix/checks/default.nix`, change the argument set to:

```nix
{
  pkgs,
  src,
  toolchain,
  overrides,
}:
```

and add this attribute after `toolchain-cache`:

```nix
  dynlink-spike = import ./dynlink-spike.nix {
    inherit pkgs toolchain;
    inherit (overrides) libhangul-wasm;
  };
```

In `nix/default.nix`, change the checks line to:

```nix
  checks = import ./checks { inherit pkgs src toolchain overrides; };
```

- [ ] **Step 6: Run the spike**

Run: `git add tests nix && nix build .#checks.x86_64-linux.dynlink-spike -L`
Expected if R3's answer is yes: the log prints the five lines of `expected.txt` and the build succeeds.

A failure is a finding, not something to force green. Record the exact output and error for Task 5 before changing anything. Two changes are in scope to try, each recorded separately:
- If `side_thread` fails or hangs, rebuild with `-sPTHREAD_POOL_SIZE=0` in the main link (threads created after the `dlopen`) and note whether it passes.
- If `side_throw` aborts instead of printing `CAUGHT`, note it; engines call into the runtime through C vtables, so an exception crossing from a side module into the main module is not required by the design.

If a change is needed to pass, keep the original output in Task 5's notes and update `expected.txt` only to what the design actually requires.

- [ ] **Step 7: Run all checks**

Run: `nix flake check -L`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add tests/spikes/dynlink nix/checks nix/default.nix
git commit -m "Add dynamic-linking spike"
```

---

### Task 5: Record the spike's findings

**Files:**
- Create: `docs/spikes/2026-09-26-dynlink.md`
- Modify: `docs/specs/2026-09-26-ibus-web-design.md` (§13, R3 and R12)

**Interfaces:**
- Consumes: Task 4's output (`nix build .#checks.x86_64-linux.dynlink-spike` then `cat result/actual.txt`) and any failures recorded in Task 4 Step 6.

- [ ] **Step 1: Capture the toolchain versions**

Run: `nix eval --raw .#packages.x86_64-linux.emscriptenCache.version; echo; nix eval --raw --inputs-from . nixpkgs#emscripten.llvmEnv; echo`
Expected: `6.0.9`, and a store path ending in `emscripten-llvm-6.0.9` (whose `bin/clang` reports LLVM 22.1.8: `$(nix eval --raw --inputs-from . nixpkgs#emscripten.llvmEnv)/bin/clang --version | head -1`).

- [ ] **Step 2: Write the findings document**

`docs/spikes/2026-09-26-dynlink.md`, using the actual output. The structure:

````markdown
# Dynamic-linking spike (M0.1)

- **Date:** <date the spike ran>
- **Toolchain:** nixpkgs `8ce4ef6`, Emscripten 6.0.9, LLVM <version from Step 1>, Node <`node --version`>
- **Build:** `nix build .#checks.x86_64-linux.dynlink-spike`

## Setup

Main module: C++, `-fPIC -pthread -fwasm-exceptions -O2 -sMAIN_MODULE=1
-sPTHREAD_POOL_SIZE=2 -sNODERAWFS=1 -sEXIT_RUNTIME=1`. Side modules:
`-sSIDE_MODULE=1` with the same compile flags, loaded with `dlopen` after the
thread pool exists.

## Results

| Side module | Result | Notes |
|---|---|---|
| side_basic | <PASS/FAIL> | |
| side_thread | <PASS/FAIL> | <pool size used; hang or error text if any> |
| side_cxx | <PASS/FAIL> | |
| side_throw | <CAUGHT/aborted> | <error text if aborted> |
| side_hangul | <PASS/FAIL> | |

Raw output:

```text
<contents of result/actual.txt>
```

## Conclusions for the design

- <R3: whether side modules loaded after the pool exists can run on pool threads>
- <whether C++ exceptions work within and across modules, and what the runtime must therefore guarantee>
- <anything that changes spec §5.3 or §5.4>
````

Replace every `<…>` with what was observed. Do not commit the document with any `<…>` left in it.

- [ ] **Step 3: Update the spec's risk entries**

In `docs/specs/2026-09-26-ibus-web-design.md` §13, append to R3 one sentence stating the spike result and linking `docs/spikes/2026-09-26-dynlink.md`. Append to R12: "At `8ce4ef6`, nixpkgs pairs Emscripten 6.0.9 with LLVM 22.1.8; upstream Emscripten expects 24." (replace 22.1.8 with the Step 1 value if it differs).

Run: `grep -n 'dynlink.md' docs/specs/2026-09-26-ibus-web-design.md`
Expected: one match, in R3.

- [ ] **Step 4: Commit**

```bash
git add docs/spikes/2026-09-26-dynlink.md docs/specs/2026-09-26-ibus-web-design.md
git commit -m "Record dynamic-linking spike findings"
```
