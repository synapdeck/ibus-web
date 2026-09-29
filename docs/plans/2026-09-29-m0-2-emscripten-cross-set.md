# M0.2: Emscripten cross package set — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `wasmStdenv` with a nixpkgs cross package set for
`wasm32-unknown-none` whose compiler is Emscripten, so unmodified nixpkgs
recipes build for WASM with their dependencies, `pkg-config`, Meson and CMake
handled by nixpkgs' own cross-compilation machinery.

**Architecture:** `modules/toolchain/cross.nix` instantiates nixpkgs with
`crossSystem = wasm32-unknown-none` (made static) and uses
`config.replaceCrossStdenv` to swap the cross stdenv's compiler for Emscripten
wrapped by nixpkgs' `cc-wrapper`. The result is exposed as
`ibusWeb.toolchain.pkgsWasm`. WASM packages become plain `pkgsWasm.<name>`.
libhangul moves over unchanged; zlib and libffi (GLib's dependencies) are
added and proven through a small Meson program.

**Tech stack:** Nix flakes, flake-parts, import-tree, treefmt-nix, nixpkgs
cross compilation (`crossSystem`, `replaceCrossStdenv`, `wrapCCWith`,
`wrapBintoolsWith`, `stdenvAdapters.makeStaticLibraries`), nixpkgs Emscripten
6.0.9, Meson, Node.

**Scope:** Second slice of spec milestone M0. Not in this plan: the GLib patch
forward-port, `libibus-web`, the Worker wait loop (R2), CMake recipes, CI.

**Evidence this works:** a scratch build on 2026-09-29 (recorded in the
project memory) built and ran a threaded C++ program with exceptions through
this cross stdenv, and built nixpkgs' unmodified libhangul recipe, found it
through the cross `pkg-config`, and composed 한 with it.

## Global constraints

- nixpkgs revision: `8ce4ef6cb6f871616146b9fe26d2a5ae594e94fe`, locked through `flake.lock`.
- Emscripten comes from nixpkgs; no compiler patches; never `-sEMULATE_FUNCTION_POINTER_CASTS`.
- Every WASM object is compiled with `ibusWeb.toolchain.commonFlags` (`-fPIC -pthread -fwasm-exceptions`).
- **Derive, don't hardcode:** versions, target prefixes, triples and store paths come from Nix evaluation (for example `stdenv.cc.targetPrefix`, `emscripten.version`), never spelled out as literals.
- Dendritic layout: `flake.nix` holds only inputs and `mkFlake … (inputs.import-tree ./modules)`; every `.nix` file under `modules/` is a flake-parts module; modules never `import` each other and share values only through `ibusWeb.*` per-system options.
- Non-Nix files a module needs live in a `_`-prefixed path next to it; test programs shared with the spec's layout live under `tests/`.
- Emscripten must come from `pkgsBuildBuild` inside the cross set. `buildPackages` (`pkgsBuildHost`) gives it a WASM target platform, which rehashes it and everything under it (openjdk included) and misses the binary cache.
- In `nativeBuildInputs`, reference packages from `pkgsWasm` directly (they are spliced to the build platform); use `pkgsBuildBuild` only where a build tool's store path is interpolated into a string.
- Main modules are linked with `em++` (`$CXX` in the cross stdenv); C sources are compiled with `$CC -c` first.
- `nix flake check` must pass at the end of every task, and a check must exist for every new WASM package (it skips building `packages.*`).
- Comments explain why, not what, and never refer to other files, this plan or its history.
- Flakes only see git-tracked files: `git add` before any `nix` command.
- The user edits files in this tree while work runs: leave changes you didn't make in place; never `git checkout`/`restore`/`stash`; commit only the task's files.

## File map

| Path | Change | Responsibility |
|---|---|---|
| `modules/toolchain/options.nix` | modify | add `pkgsWasm`; remove `wasmStdenv` |
| `modules/toolchain/cross.nix` | create | the Emscripten cross package set |
| `modules/toolchain/cross-check.nix` | create | `checks.cross-toolchain` |
| `modules/toolchain/wasm-stdenv.nix`, `modules/toolchain/_wasm-build-hook.sh` | delete | superseded by the cross set |
| `modules/toolchain/cache.nix` | modify | WasmFS main-module link in `checks.toolchain-cache` |
| `modules/wasm-packages/options.nix` | modify | description of `wasmPackages` |
| `modules/wasm-packages/libhangul.nix` | rewrite | `pkgsWasm.libhangul` |
| `modules/wasm-packages/libhangul-check.nix` | create | `checks.libhangul-wasm` through the cross `pkg-config` |
| `modules/wasm-packages/zlib.nix`, `modules/wasm-packages/libffi.nix` | create | GLib's dependencies |
| `modules/checks/meson-consumer.nix`, `tests/meson-consumer/*` | create | Meson + `pkg-config` + zlib + libffi check |
| `modules/flake/formatting.nix`, `.clang-format` | modify, create | clang-format and shfmt |
| `modules/flake/systems.nix`, `flake.nix`, `flake.lock` | modify | systems from `nix-systems/triplet` |
| `docs/specs/2026-09-26-ibus-web-design.md`, `docs/spikes/2026-09-26-dynlink.md` | modify | describe the cross set; resolve R17 |

## Shared options

| Option (under `perSystem`) | Type | After this plan |
|---|---|---|
| `ibusWeb.toolchain.commonFlags` | `str` | unchanged |
| `ibusWeb.toolchain.testMainFlags` | `str` | unchanged |
| `ibusWeb.toolchain.emscriptenCache` | `package` | unchanged |
| `ibusWeb.toolchain.emscriptenCacheHook` | `package` | unchanged; now also part of the cross stdenv |
| `ibusWeb.toolchain.wasmStdenv` | — | **removed** (Task 2) |
| `ibusWeb.toolchain.pkgsWasm` | `raw` | **new** (Task 1): nixpkgs for `wasm32-unknown-none` with Emscripten |
| `ibusWeb.wasmPackages` | `lazyAttrsOf package` | values now come from `pkgsWasm`: `libhangul` (Task 2), `zlib`, `libffi` (Task 3) |

---

### Task 1: The Emscripten cross package set

**Files:**
- Modify: `modules/toolchain/options.nix`
- Create: `modules/toolchain/cross-check.nix`, `modules/toolchain/cross.nix`

**Interfaces:**
- Consumes: `ibusWeb.toolchain.{commonFlags, testMainFlags, emscriptenCacheHook}`.
- Produces: `ibusWeb.toolchain.pkgsWasm`, a nixpkgs package set whose `stdenv` targets `wasm32-unknown-none` (static) with `stdenv.cc` wrapping `emcc`/`em++`; `checks.cross-toolchain`.

- [ ] **Step 1: Declare the option**

In `modules/toolchain/options.nix`, add this option inside `options.ibusWeb.toolchain`, after `wasmStdenv` (which Task 2 removes):

```nix
      pkgsWasm = lib.mkOption {
        type = lib.types.raw;
        description = "nixpkgs for wasm32-unknown-none, compiled with Emscripten.";
      };
```

- [ ] **Step 2: Write the failing check**

`modules/toolchain/cross-check.nix`:

```nix
{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb) toolchain;
      inherit (toolchain) pkgsWasm;
      inherit (pkgsWasm.stdenv) hostPlatform;
    in
    {
      # The probes go through the cross stdenv's own $CC and $CXX, so this
      # checks the wrapped compiler, its flags and the frozen cache together.
      checks.cross-toolchain =
        assert pkgsWasm.stdenv.cc.isClang;
        assert hostPlatform.isWasm && hostPlatform.isStatic;
        pkgsWasm.stdenv.mkDerivation {
          name = "ibus-web-cross-toolchain-check";
          src = ./_probes;
          nativeBuildInputs = [ pkgsWasm.nodejs ];
          buildPhase = ''
            runHook preBuild
            $CC -O2 -c probe.c -o probe.o
            $CXX ${toolchain.testMainFlags} probe.o -o probe-c.js
            $CXX ${toolchain.testMainFlags} probe.cpp -o probe-cpp.js
            test "$(node probe-c.js)" = "probe 7"
            test "$(node probe-cpp.js)" = "probe 2"
            runHook postBuild
          '';
          installPhase = "touch $out";
        };
    };
}
```

- [ ] **Step 3: Run it and see it fail**

Run: `git add modules && nix flake check -L`
Expected: FAIL during evaluation, because the option `ibusWeb.toolchain.pkgsWasm` is used but not defined.

- [ ] **Step 4: Write the cross set**

`modules/toolchain/cross.nix`:

```nix
{ inputs, ... }:
{
  perSystem =
    {
      config,
      lib,
      system,
      ...
    }:
    let
      inherit (config.ibusWeb) toolchain;

      replaceCrossStdenv =
        { buildPackages, baseStdenv }:
        let
          # buildPackages (pkgsBuildHost) gives Emscripten a WASM target
          # platform, which rehashes it and everything under it, openjdk
          # included, so none of it comes from the binary cache.
          pkgsBuildBuild = buildPackages.buildPackages;
          inherit (pkgsBuildBuild) emscripten;

          # cc-wrapper keys clang feature checks off the compiler's version,
          # which here is the clang Emscripten was built against.
          clangVersion = lib.getVersion (
            builtins.unsafeDiscardStringContext (baseNameOf (builtins.head emscripten.llvmEnv.paths))
          );

          # cc-wrapper wraps a clang-shaped compiler; emcc and em++ take the
          # clang and clang++ roles.
          emscriptenClang =
            pkgsBuildBuild.runCommand "emscripten-clang-${emscripten.version}"
              {
                passthru = {
                  isClang = true;
                  version = clangVersion;
                  langC = true;
                  langCC = true;
                };
              }
              ''
                mkdir -p $out/bin
                ln -s ${emscripten}/bin/emcc $out/bin/clang
                ln -s ${emscripten}/bin/em++ $out/bin/clang++
                ln -s ${emscripten}/bin/emcc $out/bin/cc
                ln -s ${emscripten}/bin/em++ $out/bin/c++
              '';

          emscriptenBinutils = pkgsBuildBuild.runCommand "emscripten-binutils-${emscripten.version}" { } ''
            mkdir -p $out/bin
            ln -s ${emscripten}/bin/emar $out/bin/ar
            ln -s ${emscripten}/bin/emranlib $out/bin/ranlib
            for tool in nm strip objdump objcopy readelf size strings; do
              ln -s ${emscripten.llvmEnv}/bin/llvm-$tool $out/bin/$tool
            done
            ln -s ${emscripten.llvmEnv}/bin/wasm-ld $out/bin/ld
          '';

          bintools = buildPackages.wrapBintoolsWith {
            bintools = emscriptenBinutils;
            # Emscripten's libc lives in its cache sysroot, which emcc adds
            # to every command itself; a libc here would put a second set of
            # headers and libraries on the command line.
            libc = null;
            # The default list targets native ELF toolchains (relro, bindnow,
            # stack clash protection, zeroed call-used registers), several of
            # which clang rejects for wasm32-unknown-emscripten.
            defaultHardeningFlags = [
              "format"
              "pic"
              "strictflexarrays1"
            ];
          };

          cc = buildPackages.wrapCCWith {
            cc = emscriptenClang;
            inherit bintools;
            libc = null;
            isClang = true;
            # emcc picks its own target and adds its sysroot's include paths,
            # so the wrapper's --target and -nostdlibinc (meant to hide
            # /usr/include) would only fight it.
            extraBuildCommands = ''
              rm -f $out/nix-support/add-local-cc-cflags-before.sh
              sed -i '/-nostdlibinc/d' $out/nix-support/cc-cflags
              echo "${toolchain.commonFlags}" >> $out/nix-support/cc-cflags
            '';
          };
        in
        buildPackages.stdenvAdapters.makeStaticLibraries (
          baseStdenv.override (old: {
            inherit cc;
            extraNativeBuildInputs = old.extraNativeBuildInputs ++ [ toolchain.emscriptenCacheHook ];
          })
        );
    in
    {
      ibusWeb.toolchain.pkgsWasm = import inputs.nixpkgs {
        localSystem = system;
        # Side modules link their libraries statically, so every recipe
        # builds static libraries only.
        crossSystem = lib.systems.examples.wasm32-unknown-none // {
          isStatic = true;
        };
        config = {
          # Recipes' platform lists predate this target; building them for
          # it is the point.
          allowUnsupportedSystem = true;
          inherit replaceCrossStdenv;
        };
      };
    };
}
```

- [ ] **Step 5: Confirm nothing large builds from source**

Run: `git add modules && nix build .#checks.x86_64-linux.cross-toolchain --dry-run 2>&1 | grep -A40 'will be built'`
Expected: only small derivations: the two `runCommand` wrappers, the bintools and cc wrappers, `stdenv-linux`, and the check. If `emscripten`, `openjdk` or `closure-compiler` appears under "will be built", Emscripten is not coming from `pkgsBuildBuild`; stop and fix that before building.

- [ ] **Step 6: Run the check**

Run: `nix build .#checks.x86_64-linux.cross-toolchain -L`
Expected: PASS. The build log shows `wasm32-unknown-none-clang` / `wasm32-unknown-none-clang++` being invoked, no `cache:INFO: generating system library` lines (the frozen cache covers the variants), and no `Permission denied`.

If a compile fails on an unsupported flag, the wrapper is injecting a native-only flag: find its source with `NIX_DEBUG=1` in the check's environment, and remove it at the wrapper level (hardening list or `extraBuildCommands`), not per package. If the build reports `Permission denied` under `sysroot/lib`, the cache lacks a variant; read the library name from the error, add a probe compile for it to `modules/toolchain/cache.nix`, and record the change in your report.

- [ ] **Step 7: Run all checks, then commit**

Run: `nix flake check -L`
Expected: PASS, including `cross-toolchain`.

```bash
git add modules/toolchain/options.nix modules/toolchain/cross.nix modules/toolchain/cross-check.nix
git commit -m "Add an Emscripten-backed wasm32 cross package set"
```

---

### Task 2: Move libhangul to the cross set and remove `wasmStdenv`

**Files:**
- Create: `modules/wasm-packages/libhangul-check.nix`
- Rewrite: `modules/wasm-packages/libhangul.nix`
- Modify: `modules/wasm-packages/options.nix`, `modules/toolchain/options.nix`
- Delete: `modules/toolchain/wasm-stdenv.nix`, `modules/toolchain/_wasm-build-hook.sh`

**Interfaces:**
- Consumes: `ibusWeb.toolchain.{pkgsWasm, testMainFlags}` (Task 1); `modules/wasm-packages/_tests/libhangul-test.c` (exists; prints `preedit U+D55C`).
- Produces: `ibusWeb.wasmPackages.libhangul = pkgsWasm.libhangul` (unmodified recipe); `packages.libhangul-wasm`; `checks.libhangul-wasm`. `checks.dynlink-spike` keeps reading `wasmPackages.libhangul` (`include/hangul-1.0`, `lib/libhangul.a`).

- [ ] **Step 1: Write the new check**

Delete the existing `checks.libhangul-wasm` line from `modules/wasm-packages/libhangul.nix` (the check now lives in its own module), then create `modules/wasm-packages/libhangul-check.nix`:

```nix
{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb) toolchain wasmPackages;
      inherit (toolchain) pkgsWasm;
      libhangul = wasmPackages.libhangul;
      pkgConfig = "${pkgsWasm.stdenv.cc.targetPrefix}pkg-config";
    in
    {
      # Builds against the installed library through the cross pkg-config,
      # the way an engine will find it.
      checks.libhangul-wasm =
        assert libhangul.stdenv.hostPlatform.isWasm;
        pkgsWasm.runCommandCC "ibus-web-libhangul-check"
          {
            nativeBuildInputs = [
              pkgsWasm.nodejs
              pkgsWasm.pkg-config
            ];
            buildInputs = [ libhangul ];
          }
          ''
            $CC -O2 $(${pkgConfig} --cflags libhangul) -c ${./_tests/libhangul-test.c} -o libhangul-test.o
            $CXX ${toolchain.testMainFlags} libhangul-test.o $(${pkgConfig} --libs libhangul) -o libhangul-test.js
            node libhangul-test.js | tee $out
            grep -qx "preedit U+D55C" $out
          '';
    };
}
```

- [ ] **Step 2: Run it and see it fail**

Run: `git add modules && nix flake check -L`
Expected: FAIL during evaluation on `assert libhangul.stdenv.hostPlatform.isWasm`, because `wasmPackages.libhangul` is still the native-platform `wasmStdenv` build.

- [ ] **Step 3: Take libhangul from the cross set**

Replace `modules/wasm-packages/libhangul.nix`:

```nix
{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb.toolchain) pkgsWasm;
    in
    {
      ibusWeb.wasmPackages.libhangul = pkgsWasm.libhangul;
      packages.libhangul-wasm = pkgsWasm.libhangul;
    };
}
```

In `modules/wasm-packages/options.nix`, change the description to:

```nix
      description = "WASM packages from the Emscripten cross package set, keyed by nixpkgs attribute name.";
```

- [ ] **Step 4: Remove `wasmStdenv`**

Run: `git rm modules/toolchain/wasm-stdenv.nix modules/toolchain/_wasm-build-hook.sh`

In `modules/toolchain/options.nix`, delete the whole `wasmStdenv = lib.mkOption { … };` block.

- [ ] **Step 5: Run the checks**

Run: `git add modules && nix build .#checks.x86_64-linux.libhangul-wasm -L`
Expected: PASS, printing `preedit U+D55C`.

Run: `nix build .#checks.x86_64-linux.dynlink-spike -L`
Expected: PASS with the same five probe lines as before, now linking the cross-built `libhangul.a`.

Run: `grep -rn wasmStdenv modules`
Expected: no output.

Run: `nix flake check -L`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add modules
git commit -m "Build libhangul from the cross set; remove wasmStdenv"
```

---

### Task 3: zlib, libffi and a Meson consumer

GLib needs zlib and libffi, and it builds with Meson and passes defines
through `NIX_CFLAGS_COMPILE`. This task adds both libraries from the cross
set, unmodified, and proves Meson's cross setup, `pkg-config`, a recipe's
`NIX_CFLAGS_COMPILE` and both libraries with one small program.

**Files:**
- Create: `modules/wasm-packages/zlib.nix`, `modules/wasm-packages/libffi.nix`, `modules/checks/meson-consumer.nix`, `tests/meson-consumer/meson.build`, `tests/meson-consumer/main.c`

**Interfaces:**
- Consumes: `ibusWeb.toolchain.pkgsWasm`.
- Produces: `ibusWeb.wasmPackages.zlib`, `ibusWeb.wasmPackages.libffi`, `packages.zlib-wasm`, `packages.libffi-wasm`, `checks.meson-consumer` (output contains `zlib ok` and `ffi 42`; compiling at all proves a recipe's `NIX_CFLAGS_COMPILE` reaches `emcc`).

- [ ] **Step 1: Write the consumer program**

`tests/meson-consumer/main.c`:

```c
/* Exercises zlib and libffi once each, as found through pkg-config. */
#ifndef IBUS_WEB_RECIPE_CFLAGS
#error "the recipe's NIX_CFLAGS_COMPILE did not reach the compiler"
#endif

#include <ffi.h>
#include <stdio.h>
#include <string.h>
#include <zlib.h>

static int add(int a, int b) { return a + b; }

static int zlib_round_trip(void) {
  const char text[] = "hello hello hello hello";
  unsigned char packed[128];
  char unpacked[sizeof text];
  uLongf packed_len = sizeof packed;
  uLongf unpacked_len = sizeof unpacked;

  if (compress(packed, &packed_len, (const Bytef *)text, sizeof text) != Z_OK)
    return 0;
  if (uncompress((Bytef *)unpacked, &unpacked_len, packed, packed_len) != Z_OK)
    return 0;
  return unpacked_len == sizeof text && memcmp(text, unpacked, sizeof text) == 0;
}

static int ffi_add(void) {
  ffi_cif cif;
  ffi_type *arg_types[2] = {&ffi_type_sint, &ffi_type_sint};
  int a = 40, b = 2;
  void *args[2] = {&a, &b};
  ffi_arg result = 0;

  if (ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 2, &ffi_type_sint, arg_types) != FFI_OK)
    return -1;
  ffi_call(&cif, FFI_FN(add), &result, args);
  return (int)result;
}

int main(void) {
  printf("zlib %s\n", zlib_round_trip() ? "ok" : "failed");
  printf("ffi %d\n", ffi_add());
  return 0;
}
```

`tests/meson-consumer/meson.build`:

```meson
project('meson-consumer', 'c')

executable(
  'meson-consumer',
  'main.c',
  dependencies: [dependency('zlib'), dependency('libffi')],
  # A threaded program keeps its runtime alive after main returns, and
  # stdout is only flushed when the runtime exits.
  link_args: ['-sEXIT_RUNTIME=1'],
  name_suffix: 'js',
)
```

- [ ] **Step 2: Write the failing check**

`modules/checks/meson-consumer.nix`:

```nix
{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb) toolchain wasmPackages;
      inherit (toolchain) pkgsWasm;
    in
    {
      # nixpkgs' Meson setup hook writes the cross file; this proves it, the
      # cross pkg-config and both libraries in one program.
      checks.meson-consumer = pkgsWasm.stdenv.mkDerivation {
        name = "ibus-web-meson-consumer";
        src = ../../tests/meson-consumer;
        nativeBuildInputs = [
          pkgsWasm.meson
          pkgsWasm.ninja
          pkgsWasm.pkg-config
          pkgsWasm.nodejs
        ];
        buildInputs = [
          wasmPackages.zlib
          wasmPackages.libffi
        ];
        # Recipes such as GLib's pass defines this way; main.c refuses to
        # compile if the wrapper drops them.
        env.NIX_CFLAGS_COMPILE = "-DIBUS_WEB_RECIPE_CFLAGS";
        installPhase = ''
          runHook preInstall
          node meson-consumer.js | tee $out
          grep -qx "zlib ok" $out
          grep -qx "ffi 42" $out
          runHook postInstall
        '';
      };
    };
}
```

Run: `git add modules tests && nix flake check -L`
Expected: FAIL during evaluation: `wasmPackages.zlib` does not exist.

- [ ] **Step 3: Add zlib and libffi**

`modules/wasm-packages/zlib.nix`:

```nix
{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb.toolchain) pkgsWasm;
    in
    {
      ibusWeb.wasmPackages.zlib = pkgsWasm.zlib;
      packages.zlib-wasm = pkgsWasm.zlib;
    };
}
```

`modules/wasm-packages/libffi.nix`:

```nix
{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb.toolchain) pkgsWasm;
    in
    {
      ibusWeb.wasmPackages.libffi = pkgsWasm.libffi;
      packages.libffi-wasm = pkgsWasm.libffi;
    };
}
```

- [ ] **Step 4: Build the libraries**

Run: `git add modules && nix build .#zlib-wasm .#libffi-wasm -L`
Expected: both build. `ls result/lib result-1/lib` lists `libz.a` and `libffi.a` (static only, no `.so`), plus `pkgconfig/`.

If libffi's configure rejects the host, `wasm32-*-*` in its `configure.host` should match `wasm32-unknown-none`; check the log for the triple it received. If a recipe fails in a way that needs a per-package override, stop and report BLOCKED with the log excerpt rather than adding one; overrides are a design decision for the plan.

- [ ] **Step 5: Run the consumer**

Run: `nix build .#checks.x86_64-linux.meson-consumer -L`
Expected: PASS. The log shows Meson configuring with a cross file (`Build machine` x86_64, `Host machine` wasm32), and the output lines `zlib ok` and `ffi 42`.

libffi's WASM backend calls through JavaScript, and it can depend on Emscripten link settings. If `ffi_call` traps or prints a wrong number, record the exact output and error and report DONE_WITH_CONCERNS; don't add link flags speculatively.

- [ ] **Step 6: Run all checks, then commit**

Run: `nix flake check -L`
Expected: PASS, including `meson-consumer`.

```bash
git add modules/wasm-packages/zlib.nix modules/wasm-packages/libffi.nix modules/checks/meson-consumer.nix tests/meson-consumer
git commit -m "Add zlib and libffi from the cross set; prove Meson with them"
```

---

### Task 4: WasmFS main module in the cache check

The runtime will be a `-sMAIN_MODULE=2` WasmFS main module. The cache is
built for that link setting, but no check links it.

**Files:**
- Modify: `modules/toolchain/cache.nix`

**Interfaces:**
- Consumes: the `mainLinkWasmfs` binding already in `modules/toolchain/cache.nix`.
- Produces: `checks.toolchain-cache` also links and runs a WasmFS main module.

- [ ] **Step 1: Add the link**

In `modules/toolchain/cache.nix`, inside `checks.toolchain-cache`, directly after the line `test "$(node probe-cpp.js)" = "probe 2"`, insert:

```nix
            em++ ${toolchain.commonFlags} -O2 ${mainLinkWasmfs} probe.o -o probe-wasmfs.js
            test "$(node probe-wasmfs.js)" = "probe 7"
```

- [ ] **Step 2: Run the check**

Run: `git add modules && nix build .#checks.x86_64-linux.toolchain-cache -L`
Expected: PASS. If it fails with `Permission denied`, the cache lacks a WasmFS variant; add the matching probe compile to `emscriptenCache` and record it.

- [ ] **Step 3: Run all checks, then commit**

Run: `nix flake check -L`
Expected: PASS.

```bash
git add modules/toolchain/cache.nix
git commit -m "Check a WasmFS main-module link against the cache"
```

---

### Task 5: Format C, C++ and shell sources

**Files:**
- Modify: `modules/flake/formatting.nix`
- Create: `.clang-format`
- Reformatted by the tool: C, C++ and shell files under `modules/` and `tests/`

**Interfaces:**
- Produces: `nix fmt` and `checks.treefmt` cover `*.c`, `*.cpp`, `*.h` and `*.sh`.

- [ ] **Step 1: Configure the formatters**

`.clang-format`:

```yaml
BasedOnStyle: LLVM
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
        programs.clang-format.enable = true;
        programs.shfmt = {
          enable = true;
          indent_size = 2;
        };
      };
    };
}
```

- [ ] **Step 2: See the check fail on the existing sources**

Run: `git add .clang-format modules && nix build .#checks.x86_64-linux.treefmt -L`
Expected: FAIL, listing C/C++ files that clang-format would change. (If it passes, every file already matches LLVM style; say so in your report.)

- [ ] **Step 3: Format and confirm behavior is unchanged**

Run: `nix fmt`
Then: `git diff --stat` and read the diff: it must contain only whitespace and layout changes.

Run: `git add -A modules tests && nix flake check -L`
Expected: PASS, with every check rebuilt from the reformatted sources producing the same results.

- [ ] **Step 4: Commit**

```bash
git add .clang-format modules tests
git commit -m "Format C, C++ and shell sources with clang-format and shfmt"
```

---

### Task 6: Restore Darwin to the system list

R17 kept the flake Linux-only because recipes restricted to Linux refused to
evaluate against a native `hostPlatform`. The cross set's `hostPlatform` is
WASM, so that reason is gone. Darwin builds can't be verified here (no Darwin
builder), so the gate is evaluation.

**Files:**
- Modify: `flake.nix` (`systems` input URL), `flake.lock`

**Interfaces:**
- Produces: systems `aarch64-darwin`, `aarch64-linux`, `x86_64-linux`.

- [ ] **Step 1: Switch the input**

In `flake.nix`, change `systems.url = "github:nix-systems/default-linux";` to:

```nix
    systems.url = "github:nix-systems/triplet";
```

Run: `nix flake lock --update-input systems` (or `nix flake update systems` if that syntax is rejected), then `grep -c 8ce4ef6cb6f871616146b9fe26d2a5ae594e94fe flake.lock`
Expected: only the `systems` lock node changes; the grep prints `1`.

- [ ] **Step 2: Evaluate every system**

Run: `git add flake.nix flake.lock && for s in x86_64-linux aarch64-linux aarch64-darwin; do echo "$s:"; nix eval --json .#checks.$s --apply 'cs: builtins.mapAttrs (n: c: c.drvPath) cs'; done`
Expected: for each system, a JSON object mapping the same check names to `.drv` paths, and no evaluation error. (Printing `drvPath` forces every check's derivation to evaluate, not just its name.)

Run: `nix eval --raw .#devShells.aarch64-darwin.default.drvPath`
Expected: a store path.

If `aarch64-darwin` fails to evaluate, report BLOCKED with the error. Don't switch back or work around it without a decision.

- [ ] **Step 3: Run the checks, then commit**

Run: `nix flake check -L`
Expected: PASS (it builds only the current system).

```bash
git add flake.nix flake.lock
git commit -m "Evaluate on Darwin again: systems from nix-systems/triplet"
```

---

### Task 7: Update the spec and the spike findings

**Files:**
- Modify: `docs/specs/2026-09-26-ibus-web-design.md`, `docs/spikes/2026-09-26-dynlink.md`

**Interfaces:**
- Consumes: the results of Tasks 1–6 (read their commits with `git log`, and the reports if you have them).

- [ ] **Step 1: Rewrite the WASM-builds paragraph in §10.2**

Replace the paragraph that begins "WASM builds follow the pattern in nixpkgs' Emscripten documentation" with:

```markdown
WASM builds come from a nixpkgs cross package set, `pkgsWasm`: nixpkgs
instantiated for `wasm32-unknown-none` (made static), with the cross stdenv's
compiler replaced by Emscripten through `config.replaceCrossStdenv` (§10.3).
Recipes are used unmodified. Their dependencies, `pkg-config`, and their
autotools, Meson and CMake configuration all come from nixpkgs' ordinary
cross-compilation machinery. Only packages nixpkgs lacks (`libibus-web`, the
custom table engine) get recipes of their own.
```

- [ ] **Step 2: Rewrite the `wasmStdenv` and per-package-override bullets in §10.3**

Replace the bullet that begins "**`wasmStdenv`.**" with:

```markdown
- **`pkgsWasm`.** `import nixpkgs` with `crossSystem` set to nixpkgs'
  `wasm32-unknown-none` example plus `isStatic = true`, and
  `config.replaceCrossStdenv` swapping the compiler:
  - `emcc` and `em++` are wrapped by nixpkgs' `cc-wrapper` as a clang
    (`stdenv.cc.isClang`), with its version taken from the clang Emscripten
    is built against. The wrapper adds `-fPIC -pthread -fwasm-exceptions` to
    every compile and link.
  - The wrapper's `--target` and `-nostdlibinc` are removed (emcc chooses its
    own target and sysroot), and the hardening defaults are limited to
    `format`, `pic` and `strictflexarrays1`.
  - `libc` is `null`: Emscripten's libc lives in its cache sysroot, which
    emcc adds itself.
  - `stdenvAdapters.makeStaticLibraries` makes every recipe build static
    libraries, and the frozen-cache hook is part of the stdenv.
  - Emscripten comes from `pkgsBuildBuild`. `buildPackages` gives it a WASM
    target platform, which rehashes it and misses the binary cache.
  - `config.allowUnsupportedSystem` is set, because recipes' platform lists
    predate this target.
```

Replace the bullet that begins "**Per-package overrides** do four things" (and its numbered list) with:

```markdown
- **Per-package overrides** are applied to `pkgsWasm` recipes only where a
  recipe needs them, and do three things, and nothing else:
  1. drop desktop-only inputs and features: GTK and Python setup programs,
     `wrapGAppsHook3`, GObject introspection, libnotify, and network features
     such as ibus-libpinyin's cloud input (`libsoup_3`, `--enable-cloud-input-mode`);
  2. drop nixpkgs patches that only serve those features (for example
     ibus-hangul's `fix-paths.patch`, which edits the Python setup program);
  3. append our patch layers after nixpkgs' remaining patches: `patches/port`,
     then `patches/casts` as a separate list.
  Dependencies are never swapped by hand: cross splicing supplies the WASM
  builds.
```

In §10.3.1, change the first line of the derivation graph from `emscriptenCache ─ wasmStdenv` to `emscriptenCache ─ pkgsWasm`.

- [ ] **Step 3: Update the decision log and R17**

In §3, replace the D19 row's "Chosen" cell with:
`Nix flake for toolchain, every artifact, checks and the release set; dependencies, engines and data come from a nixpkgs cross package set for wasm32-unknown-none with Emscripten as its compiler; CI only builds outputs and uploads them`

Replace the whole R17 entry with:

```markdown
- **R17. Platform identity of WASM builds. Resolved.** WASM packages come
  from `pkgsWasm`, whose `hostPlatform` is `wasm32-unknown-none` (static), so
  dependencies are routed by cross splicing and recipes' platform checks see
  WASM. Evaluation succeeds on Darwin again; Darwin builds are not yet
  verified on a Darwin builder.
```

- [ ] **Step 4: Tidy R3 and the spike findings**

Replace the whole R3 entry with:

```markdown
- **R3. Dynamic linking with pthreads.** Weakest area of Emscripten dynamic
  linking. §5.3's thread pool is pre-allocated, so its workers exist before
  `main` runs and side modules load after the pool already exists: the
  harder case for dynamic linking with pthreads. The M0.1 spike tested that
  case in the `-sMAIN_MODULE=1`/`-sNODERAWFS=1`/Node configuration, and all
  five probes passed, including a side module running on a pool thread
  created before its `dlopen` and a C++ exception thrown in a side module
  caught in the main module. See `docs/spikes/2026-09-26-dynlink.md`.
  Settled for that configuration; open for §5.3's `-sMAIN_MODULE=2`/WasmFS/
  browser configuration, which the runtime plan must test.
```

In `docs/spikes/2026-09-26-dynlink.md`, change "§5.3's other configuration" to "§5.3's configuration".

- [ ] **Step 5: Check and commit**

Run: `grep -n 'wasmStdenv' docs/specs/2026-09-26-ibus-web-design.md`
Expected: no output.

Run: `nix flake check -L`
Expected: PASS.

```bash
git add docs/specs/2026-09-26-ibus-web-design.md docs/spikes/2026-09-26-dynlink.md
git commit -m "Spec: WASM builds come from an Emscripten cross package set; resolve R17"
```
