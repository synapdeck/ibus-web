# M0.1: Toolchain and dynamic-linking spike — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Nix build foundation for ibus-web and answer the spec's
risk R3: can a threaded Emscripten main module load side modules at run time,
run side-module code on pool threads, and handle C++ exceptions?

**Architecture:** A dendritic flake: `flake.nix` hands every `.nix` file under
`modules/` to flake-parts through import-tree, and each file is one
flake-parts module. The toolchain modules build a prebuilt Emscripten library
cache for this project's flags and a `wasmStdenv` that turns nixpkgs recipes
into WASM builds (spec §10.2–10.3). libhangul is the first recipe converted. A
spike under `tests/spikes/dynlink` links a main module and five side modules
and runs them under Node as a flake check.

**Tech stack:** Nix flakes, flake-parts, import-tree, treefmt-nix, numtide/devshell, flake-root, nixpkgs
Emscripten 6.0.9 (LLVM 22.1.8), Node 24, C/C++, autotools (through nixpkgs'
libhangul recipe).

**Scope:** First slice of spec milestone M0. Not in this plan: the GLib patch
forward-port, the Meson and CMake paths of `wasmStdenv`, `libibus-web`, the
Worker wait loop (R2) and CI workflows. Each gets its own plan.

## Global constraints

- nixpkgs revision: `8ce4ef6cb6f871616146b9fe26d2a5ae594e94fe` (2026-09-10), locked through `flake.lock`.
- Emscripten comes from nixpkgs (6.0.9 at that revision). No compiler patches; never `-sEMULATE_FUNCTION_POINTER_CASTS`.
- Every WASM object is compiled with `-fPIC -pthread -fwasm-exceptions`.
- Systems come from the `systems` input (`github:nix-systems/default-linux`: `aarch64-linux`, `x86_64-linux`). Every system must evaluate; builds and checks in this plan are run and verified on `x86_64-linux`. Darwin is excluded until `wasmStdenv` stops inheriting the native `hostPlatform` (spec R17).
- Everything builds through the flake; `nix flake check` must pass at the end of every task.
- **Dendritic layout:** `flake.nix` contains only inputs and `mkFlake … (inputs.import-tree ./modules)`. Every `.nix` file under `modules/` is a flake-parts module. Modules never `import` each other; they share values only through the `ibusWeb.*` per-system options.
- Non-Nix files a module needs (C sources, shell hooks) live in a `_`-prefixed directory or file next to that module; import-tree skips paths containing `/_`.
- Our code in this plan is licensed MIT OR Apache-2.0.
- Comments explain why, not what, and never refer to other files, this plan or its history.
- Flakes only see files git tracks: `git add` new files before any `nix build` or `nix flake check`.

## File map

| Path                                                                                   | Responsibility                                                   |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `flake.nix`, `flake.lock`                                                              | Inputs and the import-tree entry point                           |
| `modules/flake/systems.nix`                                                            | Supported systems                                                |
| `modules/flake/formatting.nix`                                                         | treefmt-nix: `nix fmt` and the `treefmt` check                   |
| `modules/flake/flake-root.nix`                                                         | flake-root: project-root discovery for treefmt and the dev shell |
| `modules/flake/dev-shell.nix`                                                          | Development shell (numtide/devshell)                             |
| `modules/toolchain/options.nix`                                                        | Declares `perSystem.ibusWeb.toolchain.*`                         |
| `modules/toolchain/cache.nix`                                                          | Library cache, cache hook, flags, `toolchain-cache` check        |
| `modules/toolchain/_probes/*`                                                          | Programs whose compilation fills the library cache               |
| `modules/toolchain/_emscripten-cache-hook.sh`                                          | Per-build writable cache with a read-only library directory      |
| `modules/toolchain/wasm-stdenv.nix`, `modules/toolchain/_wasm-build-hook.sh`           | Emscripten stdenv for nixpkgs recipes                            |
| `modules/wasm-packages/options.nix`                                                    | Declares `perSystem.ibusWeb.wasmPackages`                        |
| `modules/wasm-packages/libhangul.nix`, `modules/wasm-packages/_tests/libhangul-test.c` | WASM libhangul and its install check                             |
| `modules/spikes/dynlink.nix`, `tests/spikes/dynlink/*`                                 | Dynamic-linking spike                                            |
| `docs/spikes/2026-09-26-dynlink.md`                                                    | Spike findings                                                   |

## Shared options

These are the only interfaces between modules. A module may read an option
only once the task that declares it is done.

| Option (under `perSystem`)              | Type                  | Declared in | Set in               |
| --------------------------------------- | --------------------- | ----------- | -------------------- |
| `ibusWeb.toolchain.commonFlags`         | `str`                 | Task 2      | Task 2               |
| `ibusWeb.toolchain.testMainFlags`       | `str`                 | Task 2      | Task 2               |
| `ibusWeb.toolchain.emscriptenCache`     | `package`             | Task 2      | Task 2               |
| `ibusWeb.toolchain.emscriptenCacheHook` | `package`             | Task 2      | Task 2               |
| `ibusWeb.toolchain.wasmStdenv`          | `raw`                 | Task 2      | Task 3               |
| `ibusWeb.wasmPackages`                  | `lazyAttrsOf package` | Task 3      | Task 3 (`libhangul`) |

---

### Task 1: Dendritic flake skeleton with formatting

**Files:**

- Create: `flake.nix`, `modules/flake/systems.nix`, `modules/flake/formatting.nix`, `.gitignore`, `LICENSE-MIT`, `LICENSE-APACHE`
- Generated: `flake.lock`

**Interfaces:**

- Produces: the flake outputs `formatter.x86_64-linux` and `checks.x86_64-linux.treefmt`. Later tasks add modules under `modules/` and touch `flake.nix` only to add inputs.

- [ ] **Step 1: Confirm there is nothing to check yet**

Run: `cd ~/Development/ibus-web && nix flake check`
Expected: FAIL with an error that `flake.nix` does not exist.

- [ ] **Step 2: Write `flake.nix`**

```nix
{
  description = "ibus-web: IBus engines running in the browser";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-parts = {
      url = "github:hercules-ci/flake-parts";
      inputs.nixpkgs-lib.follows = "nixpkgs";
    };
    import-tree.url = "github:denful/import-tree";
    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = inputs: inputs.flake-parts.lib.mkFlake { inherit inputs; } (inputs.import-tree ./modules);
}
```

- [ ] **Step 3: Write `modules/flake/systems.nix`**

```nix
{
  systems = [ "x86_64-linux" ];
}
```

- [ ] **Step 4: Write `modules/flake/formatting.nix`**

```nix
{ inputs, ... }:
{
  imports = [ inputs.treefmt-nix.flakeModule ];

  perSystem.treefmt = {
    projectRootFile = "flake.nix";
    programs.nixfmt.enable = true;
  };
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
Expected: `flake.lock` is created with nodes for `nixpkgs`, `flake-parts`, `import-tree` and `treefmt-nix`.

Run: `grep -c 8ce4ef6cb6f871616146b9fe26d2a5ae594e94fe flake.lock`
Expected: `1`

- [ ] **Step 8: Run the checks**

Run: `git add -A && nix flake check -L`
Expected: PASS, with `checks.x86_64-linux.treefmt` evaluated. If treefmt reports unformatted files, run `nix fmt` and re-run.

Run: `nix flake show 2>/dev/null | grep -E 'formatter|treefmt'`
Expected: lines for `formatter` and `checks … treefmt`.

- [ ] **Step 9: Commit**

```bash
git add flake.nix flake.lock modules .gitignore LICENSE-MIT LICENSE-APACHE
git commit -m "Add dendritic flake skeleton with treefmt"
```

---

### Task 2: Prebuilt Emscripten library cache

nixpkgs' Emscripten ships libraries only for non-PIC variants, so without this
every PIC build would compile libc and libc++ again (spec §10.3).

**Files:**

- Create: `modules/toolchain/options.nix`, `modules/toolchain/cache.nix`, `modules/toolchain/_emscripten-cache-hook.sh`, `modules/toolchain/_probes/probe.c`, `modules/toolchain/_probes/probe.cpp`, `modules/toolchain/_probes/probe_side.c`, `modules/toolchain/_probes/probe_side.cpp`, `modules/flake/flake-root.nix`, `modules/flake/dev-shell.nix`
- Modify: `flake.nix` (two inputs), `flake.lock`, `modules/flake/formatting.nix`

**Interfaces:**

- Consumes: the Task 1 flake.
- Produces (per system):
  - `ibusWeb.toolchain.commonFlags` = `"-fPIC -pthread -fwasm-exceptions"`
  - `ibusWeb.toolchain.testMainFlags`: `-O2` plus link flags for Node-run test main modules, identical to a combination the cache was built for. Main modules link with `em++`, never `emcc`; C sources are compiled with `emcc -c` first.
  - `ibusWeb.toolchain.emscriptenCache`: an Emscripten cache directory
  - `ibusWeb.toolchain.emscriptenCacheHook`: a setup hook that sets `EM_CACHE` to a writable per-build copy whose `sysroot/lib` is read-only, and sets `HOME` when it is the sandbox placeholder
  - `ibusWeb.toolchain.wasmStdenv`: declared here, set in Task 3
  - outputs `packages.emscriptenCache`, `checks.toolchain-cache`, `devShells.default` (through devshell's `devshells.default`)
  - `config.flake-root.projectRootFile` and `config.flake-root.package` (from flake-root's module)

- [ ] **Step 1: Declare the toolchain options**

`modules/toolchain/options.nix`:

```nix
{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.toolchain = {
      commonFlags = lib.mkOption {
        type = lib.types.str;
        description = "Compiler flags every WASM object is built with.";
      };
      testMainFlags = lib.mkOption {
        type = lib.types.str;
        description = "Link flags for Node-run test programs; a combination the library cache covers.";
      };
      emscriptenCache = lib.mkOption {
        type = lib.types.package;
        description = "Emscripten cache prebuilt for this project's library variants.";
      };
      emscriptenCacheHook = lib.mkOption {
        type = lib.types.package;
        description = "Setup hook giving each build a private copy of the cache.";
      };
      wasmStdenv = lib.mkOption {
        type = lib.types.raw;
        description = "stdenv that builds nixpkgs recipes as static PIC WASM libraries.";
      };
    };
  };
}
```

- [ ] **Step 2: Write the probe programs**

`modules/toolchain/_probes/probe.c`:

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

`modules/toolchain/_probes/probe.cpp`:

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

`modules/toolchain/_probes/probe_side.c`:

```c
int probe(void) { return 0; }
```

`modules/toolchain/_probes/probe_side.cpp`:

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

- [ ] **Step 3: Write the cache hook**

`modules/toolchain/_emscripten-cache-hook.sh`:

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

- [ ] **Step 4: Write `modules/toolchain/cache.nix` with its failing check**

```nix
{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (pkgs) emscripten;
      inherit (config.ibusWeb) toolchain;

      commonFlags = "-fPIC -pthread -fwasm-exceptions";

      # Link settings the cache is prepared for. Emscripten picks library
      # variants from link settings, so tests must link with one of these.
      # Main modules always link with em++: they must carry the C++ runtime
      # for C++ side modules, and linking one with emcc leaves libunwind's
      # reference to __gxx_wasm_personality_v0 unresolved.
      mainLinkNode = "-sMAIN_MODULE=1 -sPTHREAD_POOL_SIZE=2 -sNODERAWFS=1 -sEXIT_RUNTIME=1";
      mainLinkWasmfs = "-sMAIN_MODULE=2 -sPTHREAD_POOL_SIZE=2 -sWASMFS=1 -sEXIT_RUNTIME=1";

      emscriptenCache = pkgs.stdenvNoCC.mkDerivation {
        pname = "emscripten-cache";
        inherit (emscripten) version;
        src = ./_probes;
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
            emcc $opt ${commonFlags} -c probe.c -o $TMPDIR/probe.o
            for link in "${mainLinkNode}" "${mainLinkWasmfs}"; do
              em++ $opt ${commonFlags} $link $TMPDIR/probe.o -o $TMPDIR/probe-c.js
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
    in
    {
      ibusWeb.toolchain = {
        inherit commonFlags emscriptenCache;
        testMainFlags = "-O2 ${mainLinkNode}";
        emscriptenCacheHook = pkgs.makeSetupHook {
          name = "emscripten-cache-hook";
          substitutions.cache = emscriptenCache;
        } ./_emscripten-cache-hook.sh;
      };

      packages.emscriptenCache = emscriptenCache;

      # Probe programs must build from the cache alone, and a variant the cache
      # lacks must fail rather than be compiled.
      checks.toolchain-cache =
        pkgs.runCommand "ibus-web-toolchain-cache-check"
          {
            nativeBuildInputs = [
              emscripten
              pkgs.nodejs
              toolchain.emscriptenCacheHook
            ];
          }
          ''
            cp ${./_probes}/* .
            emcc ${toolchain.commonFlags} -O2 -c probe.c -o probe.o
            em++ ${toolchain.commonFlags} ${toolchain.testMainFlags} probe.o -o probe-c.js
            em++ ${toolchain.commonFlags} ${toolchain.testMainFlags} probe.cpp -o probe-cpp.js
            test "$(node probe-c.js)" = "probe 7"
            test "$(node probe-cpp.js)" = "probe 2"

            if em++ ${toolchain.commonFlags} ${toolchain.testMainFlags} -sMALLOC=mimalloc probe.o -o uncached.js 2> uncached.log; then
              echo "expected an uncached library variant to fail" >&2
              exit 1
            fi
            grep -q "Permission denied" uncached.log
            touch $out
          '';
    };
}
```

- [ ] **Step 5: Add the devshell and flake-root inputs**

In `flake.nix`, add these two entries to the `inputs` attrset, after `treefmt-nix`:

```nix
    devshell = {
      url = "github:numtide/devshell";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    flake-root.url = "github:srid/flake-root";
```

Run: `nix flake lock`
Expected: `flake.lock` gains `devshell` and `flake-root` nodes; the `nixpkgs` node still names `8ce4ef6cb6f871616146b9fe26d2a5ae594e94fe` (`grep -c 8ce4ef6cb6f871616146b9fe26d2a5ae594e94fe flake.lock` prints `1`).

- [ ] **Step 6: Add flake-root and point treefmt at it**

`modules/flake/flake-root.nix`:

```nix
{ inputs, ... }:
{
  imports = [ inputs.flake-root.flakeModule ];
}
```

Replace `modules/flake/formatting.nix`:

```nix
{ inputs, ... }:
{
  imports = [ inputs.treefmt-nix.flakeModule ];

  perSystem =
    { config, ... }:
    {
      treefmt = {
        inherit (config.flake-root) projectRootFile;
        programs.nixfmt.enable = true;
      };
    };
}
```

- [ ] **Step 7: Write `modules/flake/dev-shell.nix`**

```nix
{ inputs, ... }:
{
  imports = [ inputs.devshell.flakeModule ];

  perSystem =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    {
      devshells.default = {
        packages = [
          pkgs.emscripten
          pkgs.nodejs
          config.treefmt.build.wrapper
        ];
        env = [
          {
            name = "FLAKE_ROOT";
            eval = "$(${lib.getExe config.flake-root.package})";
          }
          {
            name = "EM_CACHE";
            eval = "$FLAKE_ROOT/.emcache";
          }
        ];
        # A writable cache in the checkout, seeded from the prebuilt one.
        devshell.startup.emscripten-cache.text = ''
          if [ ! -d "$EM_CACHE" ]; then
            cp -r --no-preserve=mode ${config.ibusWeb.toolchain.emscriptenCache} "$EM_CACHE"
          fi
        '';
      };
    };
}
```

- [ ] **Step 8: Build the cache**

Run: `git add modules && nix build .#emscriptenCache -L`
Expected: the build log ends with `probe 7` and `probe 2`, and `ls result/sysroot/lib/wasm32-emscripten/pic` lists `libc-mt.a`, `libc++-mt-legacyexcept.a` and `libc++abi-mt-legacyexcept.a`. (With `-fwasm-exceptions`, Emscripten 6 defaults to the legacy WASM exception instructions, hence `legacyexcept`.)

- [ ] **Step 9: Run the checks and try the dev shell**

Run: `nix flake check -L`
Expected: PASS for `treefmt` and `toolchain-cache`. Evaluation succeeds even though `wasmStdenv` is unset, because nothing reads it yet.

If `toolchain-cache` fails on the first two compiles with `Permission denied`, the cache lacks a variant those links need. Read the library name from the error, add a probe compile to `emscriptenCache` that produces it, and re-run. If the `-sMALLOC=mimalloc` compile unexpectedly succeeds, `libmimalloc-mt` was built into the cache by a probe; pick another uncached setting (for example `-sMALLOC=emmalloc-debug`) and confirm it is missing with `ls result/sysroot/lib/wasm32-emscripten/pic`.

Run: `nix develop -c sh -c 'echo "$EM_CACHE"; ls "$EM_CACHE/sysroot/lib/wasm32-emscripten/pic" | grep -c "^libc-mt.a$"; emcc --version | head -1'`
Expected: a path ending in `ibus-web/.emcache`, then `1`, then an `emcc` 6.0.9 version line. (`.emcache/` is git-ignored.)

- [ ] **Step 10: Commit**

```bash
git add flake.nix flake.lock modules/toolchain modules/flake
git commit -m "Add prebuilt Emscripten library cache, cache check and dev shell"
```

---

### Task 3: `wasmStdenv` and a WASM build of libhangul

**Files:**

- Create: `modules/toolchain/wasm-stdenv.nix`, `modules/toolchain/_wasm-build-hook.sh`, `modules/wasm-packages/options.nix`, `modules/wasm-packages/libhangul.nix`, `modules/wasm-packages/_tests/libhangul-test.c`
- Modify: `flake.nix` (one input), `flake.lock`, `modules/flake/systems.nix`, `modules/toolchain/cache.nix`

**Interfaces:**

- Consumes: `ibusWeb.toolchain.{commonFlags,testMainFlags,emscriptenCacheHook}` (Task 2).
- Produces:
  - `ibusWeb.toolchain.wasmStdenv`: a stdenv whose `mkDerivation` accepts native nixpkgs recipes (attrset or `finalAttrs` function) and builds them with Emscripten as static PIC libraries.
  - `ibusWeb.wasmPackages` option, with `ibusWeb.wasmPackages.libhangul` set.
  - `packages.libhangul-wasm`: installs `lib/libhangul.a`, `include/hangul-1.0/hangul.h`, `lib/pkgconfig/libhangul.pc` and the Hanja data.

- [ ] **Step 0: Take the system list from `nix-systems/default-linux`**

In `flake.nix`, add this entry to the `inputs` attrset, after `flake-root`:

```nix
    systems.url = "github:nix-systems/default-linux";
```

Replace `modules/flake/systems.nix`:

```nix
{ inputs, ... }:
{
  systems = import inputs.systems;
}
```

Run: `nix flake lock && grep -c 8ce4ef6cb6f871616146b9fe26d2a5ae594e94fe flake.lock`
Expected: `flake.lock` gains a `systems` node; the grep prints `1`.

Run: `git add flake.nix flake.lock modules && nix flake show --all-systems 2>/dev/null | grep -E 'aarch64-linux|x86_64-linux' | sort -u | head`
Expected: entries for both systems, and no evaluation error.

- [ ] **Step 0b: Cache the variants configure scripts link**

Autoconf's compiler checks link plain executables (no `MAIN_MODULE`) with the
project's flags and no `-O`, which needs non-PIC threaded libraries the cache
does not yet hold.

In `modules/toolchain/cache.nix`, in `emscriptenCache`'s `buildPhase`, insert these lines inside the `for opt in -O0 -O2; do` loop, directly after the `emcc $opt ${commonFlags} -c probe.c -o $TMPDIR/probe.o` line:

```nix
            # Configure scripts link plain test executables with the
            # project's compile flags.
            emcc $opt ${commonFlags} $TMPDIR/probe.o -o $TMPDIR/probe-plain-c.js
            em++ $opt ${commonFlags} probe.cpp -o $TMPDIR/probe-plain-cpp.js
```

In `checks.toolchain-cache`, insert after the `test "$(node probe-cpp.js)" = "probe 2"` line:

```nix
            emcc ${toolchain.commonFlags} probe.o -o probe-plain.js
            test "$(node probe-plain.js)" = "probe 7"
            em++ ${toolchain.commonFlags} probe.cpp -o probe-plain-cpp.js
            test "$(node probe-plain-cpp.js)" = "probe 2"
```

Run: `git add modules && nix build .#checks.x86_64-linux.toolchain-cache -L`
Expected: PASS (the cache rebuilds first).

- [ ] **Step 1: Write the failing install check program**

`modules/wasm-packages/_tests/libhangul-test.c`:

```c
/* 2-set keys g, k, s compose to the syllable 한 (U+D55C). Built without
 * external keyboards, libhangul needs no hangul_init(): keyboard lookup falls
 * back to the built-in tables. */
#include <hangul.h>
#include <stdio.h>

int main(void) {
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
  return ok ? 0 : 1;
}
```

- [ ] **Step 2: Write the build hook**

`modules/toolchain/_wasm-build-hook.sh`:

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

- [ ] **Step 3: Write `modules/toolchain/wasm-stdenv.nix`**

```nix
{
  perSystem =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      inherit (pkgs) emscripten;
      inherit (config.ibusWeb.toolchain) commonFlags emscriptenCacheHook;

      wasmBuildHook = pkgs.makeSetupHook {
        name = "wasm-build-hook";
        substitutions = {
          inherit commonFlags;
          nm = "${emscripten.llvmEnv}/bin/llvm-nm";
        };
      } ./_wasm-build-hook.sh;
    in
    {
      # Emscripten is clang, so recipes that branch on the compiler
      # (stdenv.cc.isClang) must take their clang paths.
      ibusWeb.toolchain.wasmStdenv = pkgs.clangStdenv // {
        mkDerivation =
          fnOrAttrs:
          pkgs.clangStdenv.mkDerivation (
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
      };
    };
}
```

- [ ] **Step 4: Declare the WASM package set**

`modules/wasm-packages/options.nix`:

```nix
{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.wasmPackages = lib.mkOption {
      type = lib.types.lazyAttrsOf lib.types.package;
      default = { };
      description = "WASM builds of nixpkgs recipes, keyed by nixpkgs attribute name.";
    };
  };
}
```

- [ ] **Step 5: Write the libhangul module**

`modules/wasm-packages/libhangul.nix`:

```nix
{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) toolchain;

      libhangul = (pkgs.libhangul.override { stdenv = toolchain.wasmStdenv; }).overrideAttrs (old: {
        pname = "libhangul-wasm";
        configureFlags = old.configureFlags ++ [ "--disable-nls" ];

        doInstallCheck = true;
        installCheckPhase = ''
          runHook preInstallCheck
          emcc ${toolchain.commonFlags} -O2 -I$out/include/hangul-1.0 \
            -c ${./_tests/libhangul-test.c} -o libhangul-test.o
          em++ ${toolchain.commonFlags} ${toolchain.testMainFlags} \
            libhangul-test.o $out/lib/libhangul.a -o libhangul-test.js
          node libhangul-test.js
          runHook postInstallCheck
        '';
      });
    in
    {
      ibusWeb.wasmPackages.libhangul = libhangul;
      packages.libhangul-wasm = libhangul;
      # nix flake check skips building packages; this runs the install check.
      checks.libhangul-wasm = libhangul;
    };
}
```

- [ ] **Step 6: Build libhangul and run its install check**

Run: `git add modules && nix build .#libhangul-wasm -L`
Expected: the log shows `emconfigure ./configure ... --host=wasm32-unknown-emscripten --enable-static --disable-shared --disable-nls`, then `preedit U+D55C`, and the build succeeds.

Run: `ls result/lib result/include/hangul-1.0 result/share/libhangul/hanja`
Expected: `libhangul.a` (and `libhangul.la`, `pkgconfig/`), `hangul.h`, and `hanja.txt`.

If configure fails on `--host=wasm32-unknown-emscripten` ("Invalid configuration"), the generated `config.sub` is too old to know the triple; add `postAutoreconf = "cp ${pkgs.gnu-config}/config.sub .";` to the override and re-run. The build also installs the `hangul` command-line tool; it is harmless and not shipped. Restricting `SUBDIRS` from the make command line does not work here: as a string, stdenv word-splits it, and as an array, it leaks into automake's recursive makes.

- [ ] **Step 7: Run all checks**

Run: `nix flake check -L`
Expected: PASS, with `checks.x86_64-linux.libhangul-wasm` built (not skipped).

- [ ] **Step 8: Commit**

```bash
git add flake.nix flake.lock modules/flake/systems.nix modules/toolchain modules/wasm-packages
git commit -m "Add wasmStdenv and a WASM build of libhangul; take systems from nix-systems/default-linux"
```

---

### Task 4: Dynamic-linking spike

Answers R3. A threaded main module loads five side modules at run time with
`dlopen`, after its thread pool already exists:

| Side module   | What it shows                                                                  |
| ------------- | ------------------------------------------------------------------------------ |
| `side_basic`  | Calling into a side module that uses main-module libc                          |
| `side_thread` | Side-module code running on a pool thread created before the `dlopen`          |
| `side_cxx`    | A C++ exception thrown and caught inside a side module                         |
| `side_throw`  | A C++ exception thrown in a side module and caught in the main module          |
| `side_hangul` | A static library (libhangul) linked into a side module, the shape of an engine |

**Files:**

- Create: `tests/spikes/dynlink/main.cpp`, `tests/spikes/dynlink/side_basic.c`, `tests/spikes/dynlink/side_thread.c`, `tests/spikes/dynlink/side_cxx.cpp`, `tests/spikes/dynlink/side_throw.cpp`, `tests/spikes/dynlink/side_hangul.c`, `tests/spikes/dynlink/expected.txt`, `modules/spikes/dynlink.nix`

**Interfaces:**

- Consumes: `ibusWeb.toolchain.{commonFlags,testMainFlags,emscriptenCacheHook}` (Task 2); `ibusWeb.wasmPackages.libhangul` (Task 3).
- Produces: `checks.dynlink-spike`, whose output contains `actual.txt`. Every side module exports `int probe(void)`, returning 0 on success.

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
/* hangul.h does not bring in a definition of NULL. */
#include <stddef.h>

#include <hangul.h>

int probe(void) {
  HangulInputContext *hic = hangul_ic_new("2");
  if (hic == NULL) return 1;

  hangul_ic_process(hic, 'g');
  hangul_ic_process(hic, 'k');
  hangul_ic_process(hic, 's');
  const ucschar *preedit = hangul_ic_get_preedit_string(hic);
  int ok = preedit[0] == 0xD55C && preedit[1] == 0;

  hangul_ic_delete(hic);
  return ok ? 0 : 2;
}
```

- [ ] **Step 4: Write the spike module**

`modules/spikes/dynlink.nix`:

```nix
{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) toolchain wasmPackages;
      libhangul = wasmPackages.libhangul;
    in
    {
      checks.dynlink-spike = pkgs.stdenvNoCC.mkDerivation {
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
            -I${libhangul}/include/hangul-1.0 ${libhangul}/lib/libhangul.a \
            -o side_hangul.wasm
          runHook postBuild
        '';

        doCheck = true;
        checkPhase = ''
          runHook preCheck
          # node exits non-zero on a probe FAIL, which would abort under set -e
          # before the diagnostics below ever printed. Capture the status and
          # exit with it after showing the output, instead of letting it kill
          # the phase early.
          node main.js $PWD/side_basic.wasm $PWD/side_thread.wasm $PWD/side_cxx.wasm \
            $PWD/side_throw.wasm $PWD/side_hangul.wasm > actual.txt || status=$?
          cat actual.txt
          diff -u expected.txt actual.txt
          if [ -n "''${status:-}" ]; then
            exit "$status"
          fi
          runHook postCheck
        '';

        installPhase = ''
          runHook preInstall
          mkdir -p $out
          cp actual.txt $out/
          runHook postInstall
        '';
      };
    };
}
```

- [ ] **Step 5: Run the spike**

Run: `git add tests modules && nix build .#checks.x86_64-linux.dynlink-spike -L`
Expected if R3's answer is yes: the log prints the five lines of `expected.txt` and the build succeeds.

A failure is a finding, not something to force green. Record the exact output and error for Task 5 before changing anything. Two changes are in scope to try, each recorded separately:

- If `side_thread` fails or hangs, rebuild with `-sPTHREAD_POOL_SIZE=0` in the main link (threads created after the `dlopen`) and note whether it passes.
- If `side_throw` aborts instead of printing `CAUGHT`, note it; engines call into the runtime through C vtables, so an exception crossing from a side module into the main module is not required by the design.

If a change is needed to pass, keep the original output in Task 5's notes and update `expected.txt` only to what the design actually requires.

- [ ] **Step 6: Run all checks**

Run: `nix flake check -L`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add tests/spikes/dynlink modules/spikes
git commit -m "Add dynamic-linking spike"
```

---

### Task 5: Record the spike's findings

**Files:**

- Create: `docs/spikes/2026-09-26-dynlink.md`
- Modify: `docs/specs/2026-09-26-ibus-web-design.md` (§13, R3 and R12)

**Interfaces:**

- Consumes: Task 4's output (`nix build .#checks.x86_64-linux.dynlink-spike` then `cat result/actual.txt`) and any failures recorded in Task 4 Step 5.

- [ ] **Step 1: Capture the toolchain versions**

Run: `nix eval --raw .#packages.x86_64-linux.emscriptenCache.version; echo; $(nix eval --raw --inputs-from . nixpkgs#emscripten.llvmEnv)/bin/clang --version | head -1; nix shell --inputs-from . nixpkgs#nodejs -c node --version`
Expected: `6.0.9`, a clang version line (LLVM 22.1.8 at the pinned revision), and a Node version.

- [ ] **Step 2: Write the findings document**

`docs/spikes/2026-09-26-dynlink.md`, using the actual output. The structure:

````markdown
# Dynamic-linking spike (M0.1)

- **Date:** <date the spike ran>
- **Toolchain:** nixpkgs `8ce4ef6`, Emscripten 6.0.9, LLVM <version from Step 1>, Node <version from Step 1>
- **Build:** `nix build .#checks.x86_64-linux.dynlink-spike`

## Setup

Main module: C++, `-fPIC -pthread -fwasm-exceptions -O2 -sMAIN_MODULE=1
-sPTHREAD_POOL_SIZE=2 -sNODERAWFS=1 -sEXIT_RUNTIME=1`. Side modules:
`-sSIDE_MODULE=1` with the same compile flags, loaded with `dlopen` after the
thread pool exists.

## Results

| Side module | Result           | Notes                                       |
| ----------- | ---------------- | ------------------------------------------- |
| side_basic  | <PASS/FAIL>      |                                             |
| side_thread | <PASS/FAIL>      | <pool size used; hang or error text if any> |
| side_cxx    | <PASS/FAIL>      |                                             |
| side_throw  | <CAUGHT/aborted> | <error text if aborted>                     |
| side_hangul | <PASS/FAIL>      |                                             |

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

In `docs/specs/2026-09-26-ibus-web-design.md` §13, append to R3 one sentence stating the spike result and linking `docs/spikes/2026-09-26-dynlink.md`. Append to R12: "At `8ce4ef6`, nixpkgs pairs Emscripten 6.0.9 with LLVM 22.1.8; upstream Emscripten expects 24." (use the Step 1 LLVM version if it differs).

Run: `grep -n 'dynlink.md' docs/specs/2026-09-26-ibus-web-design.md`
Expected: one match, in R3.

- [ ] **Step 4: Commit**

```bash
git add docs/spikes/2026-09-26-dynlink.md docs/specs/2026-09-26-ibus-web-design.md
git commit -m "Record dynamic-linking spike findings"
```
