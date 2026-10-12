# Toolchain

Every WebAssembly artifact is built by the flake with Emscripten from nixpkgs. This page covers how that toolchain is
put together: the patched Emscripten, the flags every object is compiled with, the frozen library cache, the minimum
browser and Node versions, the cross package set `pkgsWasm` that builds nixpkgs recipes for WebAssembly, and dynamic
linking. GLib, the largest thing built with it, has a page of its own, [glib.md](glib.md).

Versions below are what the current `flake.lock` evaluates to: Emscripten 6.0.9, which nixpkgs builds against clang
22.1.8; Node 26.10.0; GLib 2.88.3. Nothing in the build spells them out; see
[Derive, don't hardcode](#derive-dont-hardcode).

## Emscripten

`ibusWeb.toolchain.emscripten` is nixpkgs' `emscripten` with the patches in `modules/emscripten/patches/` appended
(`modules/emscripten/module.nix`). It is the only Emscripten in the build: the library cache, the cross stdenv's
compiler wrapper, the dev shell and clangd all take it from that option, and nothing uses `pkgs.emscripten` or
`pkgsBuildBuild.emscripten` directly. The cross stdenv asserts that the cache was built by the same Emscripten
derivation as the compiler it wraps, since a cache from another Emscripten would be stale.

nixpkgs installs Emscripten's patched source tree whole under `share/emscripten`, so both the system libraries the cache
compiles (`system/lib/…`) and the JavaScript libraries every link reads (`src/lib/…`) carry the patches. Changing a
patch rebuilds the cache and everything in `pkgsWasm`.

### The patches

Each patch is a small fix tracked upstream: by an issue or pull request where one exists, otherwise by a draft report
under [`docs/upstream/`](upstream/). Each is dropped once an Emscripten release has it. They fix WasmFS (path lookup,
permissions, `poll()`, pipes, error codes, NUL bytes on its standard streams), its Node backend, the JavaScript file
system's pipes, pthreads with a blocked main thread and with dynamic linking, and an imported memory's maximum. The
patches' own README, [`modules/emscripten/patches/README.md`](../modules/emscripten/patches/README.md), lists each one
with what it fixes, its upstream reference and the release to drop it at, and explains how they stack.
`checks.emscripten-fixes` checks the behaviour each one restores.

Most of the WasmFS fixes came out of GLib's test run ([glib.md](glib.md#what-the-test-run-found)); the pthread and
memory ones out of the runtime's Worker design ([runtime.md](runtime.md)); the lookup, symlink and heartbeat ones out of
the IndexedDB backend ([storage.md](storage.md)).

### Rules

- **nixpkgs' Emscripten, small upstream-tracked fixes only.** No forked compiler and no forked LLVM. Why: everyone who
  builds an engine gets the toolchain from the flake, and a fork would be ours to maintain against every LLVM release. A
  fix stays small enough to drop when upstream ships its own.
- **Never `-sEMULATE_FUNCTION_POINTER_CASTS`.** GLib relies on calling functions through mismatched pointer types, which
  WebAssembly traps on, and upstream GLib documents this flag as the way to build it. With `-sMAIN_MODULE` it breaks
  catching C++ exceptions ([emscripten#22285](https://github.com/emscripten-core/emscripten/issues/22285), open), which
  the C++ engines need, and it slows every indirect call. The mismatches are fixed in GLib's source instead; see
  [glib.md](glib.md#function-pointer-casts).
- **nixpkgs' pairing with LLVM.** nixpkgs builds Emscripten against its own LLVM rather than the revision upstream
  Emscripten tests with, and its package only runs a hello-world test. This project's checks are the real test of that
  pairing; a codegen problem would be met by overriding the Emscripten or LLVM version in the flake (spec R12).

## Compiler flags

`ibusWeb.toolchain.commonFlags` is the set every WebAssembly object is compiled with:

| Flag                | Why                                                                                                                                                                                                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `-O2`               | Optimized over `-Os`: engine data, not code, dominates download size, and keystrokes have a latency budget. nixpkgs' Meson hook builds with `--buildtype=plain`, which adds no `-O` at all, so without this GLib compiled unoptimized.                                                                                                                 |
| `-fPIC`             | Any object can end up in a dynamically linked module: the runtime is a main module and engines are side modules that link their static libraries in. One PIC variant of everything keeps one set of libraries.                                                                                                                                         |
| `-pthread`          | The runtime's memory is shared: GLib starts threads (its worker context, `GTask`'s pool), engines may too, and the Worker host sleeps on atomics. wasm-ld refuses objects compiled without atomics in a shared-memory link.                                                                                                                            |
| `-fwasm-exceptions` | The C++ engines throw. WebAssembly's own exception handling needs no round trip through JavaScript per call, and it works across modules: an exception thrown in a side module is caught in the main module ([below](#what-was-established)).                                                                                                          |
| `-mextended-const`  | The minimum versions have extended-const, and when every target has it emcc tells `wasm-ld` and `wasm-opt` but not clang, so objects name it themselves and every stage may use it. Measured, it changes nothing in today's modules: the main module's data sits at fixed addresses and side modules import their data addresses as `GOT.mem` globals. |

How a build gets them:

- In `pkgsWasm`, the compiler wrapper adds them to every compile and link. `-O2` goes before the command's own arguments
  (`cc-cflags-before`), so a package's own `-O` still wins: a package that asks for `-O0` links against the cache's
  debug variants. `checks.toolchain-cross` checks that `__OPTIMIZE__` is defined by default and not under `-O0`.
- Builds that call `emcc` or `em++` directly (the cache, a few checks) pass `commonFlags` themselves.
- **Assertions.** An `-O2` link turns Emscripten's runtime assertions off, so every check and test link adds
  `-sASSERTIONS=1`; `testMainFlags` and GLib's executables carry it.
- **Main modules link with `em++`.** A main module carries the C++ runtime for C++ side modules, and linking one built
  with `-fwasm-exceptions` with `emcc` leaves libunwind's reference to `__gxx_wasm_personality_v0` unresolved. C and C++
  sources are compiled with `$CC -c`/`$CXX -c` first.

Other shared link settings, all options under `ibusWeb.toolchain`:

- `dynamicLinkFlags` (`-Wno-experimental -Wl,--experimental-pic`): every main or side module link adds them. emcc warns
  that dynamic linking with pthreads is experimental and wasm-ld that PIC linking is; the flags acknowledge the
  warnings, and the output is the same without them.
- `sideModuleFlags`: `-sSIDE_MODULE=1` plus the above.
- `runtimeMainFlags`: the settings of the runtime's main-module link that select library variants
  (`-sMAIN_MODULE=2 -sWASMFS=1 -sEXIT_RUNTIME=0`); the rest of that link is the runtime's ([runtime.md](runtime.md)).
- `testMemoryFlags`: a fixed 512 MiB for Node-run tests and GLib's tools in place of memory growth. With pthreads, a
  memory that grows has let threads fault out of bounds, and a program that outgrows a fixed one fails plainly; GLib's
  largest test peaks at 280 MiB ([glib.md](glib.md#how-they-run)).
- `nodeHostFsFlags`: `-sWASMFS=1 -sNODE_HOST_ENV=1` and an object (`node-host-fs.c`) that roots WasmFS at the host's `/`
  through its Node backend and starts in Node's working directory. Emscripten's `-sNODERAWFS` under WasmFS roots the
  tree at the working directory instead, so absolute paths such as `/nix/store/…` would miss.
- `testMainFlags`: the link for Node-run test programs, `-O2 -sASSERTIONS=1`, the fixed memory,
  `-sMAIN_MODULE=1 -sPTHREAD_POOL_SIZE=2 -sEXIT_RUNTIME=1`, WasmFS on the host's files and the dynamic-link flags. The
  GLib smoke check, libhangul's check and the Emscripten-fix checks link with it.

## The frozen library cache

nixpkgs precompiles Emscripten's system libraries (libc, libc++, compiler-rt, …) only in their non-PIC variants. Without
a cache of our own every PIC build would compile libc and libc++ again, into a per-build cache.

`ibusWeb.toolchain.emscriptenCache` (also `legacyPackages.<system>.emscriptenCache`) fills one by linking probe programs
(`modules/toolchain/probes/`), at `-O0` and `-O2`, with every combination of settings the builds use, so Emscripten's
own link step builds the variants those settings select, rather than guessing them with `embuilder`. The combinations:

- plain C and C++ executables, which configure scripts link;
- plain executables on WasmFS with the fixed test memory, which is how GLib's tests link;
- main modules on Node's raw file system, on WasmFS, and on WasmFS rooted at the host;
- the runtime's main-module settings, with and without assertions;
- `-sPROXY_TO_PTHREAD` programs, plain and as main modules, which is how GoogleTest programs link (see
  [testing.md](testing.md));
- C and C++ side modules.

The probes then run under Node, and the cache is installed without its build directory.

`ibusWeb.toolchain.emscriptenCacheHook` is a setup hook (part of the cross stdenv) that gives each build a private,
writable copy of the cache and makes its `sysroot/lib` read-only. A build that needs a variant the cache lacks fails
with `Permission denied` instead of silently compiling libc again. A new link setting that selects different library
variants therefore needs a probe link in the cache. The hook also points `HOME` into the build, since Emscripten writes
there.

`checks.toolchain-cache` links and runs the probes against the frozen cache with the shared flag sets, including the
runtime's link with the memory a host gives it, and proves that an uncached variant (`-sMALLOC=mimalloc`) fails with
`Permission denied`.

## Minimum browser and Node versions

Emscripten decides which WebAssembly features and which JavaScript it emits from
`-sMIN_{CHROME,FIREFOX,SAFARI,NODE}_VERSION`. Every link gets them from `ibusWeb.toolchain.minimumVersions`, never by
hand, so Emscripten's own glue assumes what the project's hand-written TypeScript assumes (Baseline Widely available).

- **Browsers** are those Baseline Widely available covers, from baseline-browser-mapping's CLI, run in a derivation
  (`modules/toolchain/minimum-versions.nix`). The package is built from source in `modules/baseline-browser-mapping/`
  (`packages.<system>.baseline-browser-mapping`, version 2.11.27, with a `nix-update` script). The CLI is asked for the
  browsers on the date its own data was last updated (`lastUpdated` in its `timeline.js`), not the build machine's date,
  so the result moves only when the package does.
- **Node** is the workspace's Node, `ibusWeb.typescript.nodejs`, encoded as Emscripten writes versions
  (`major * 10000 + minor * 100 + patch`). Node runs the tools and the tests, not production, so the workspace takes the
  newest line nixpkgs has, Node 26. Node 24.21's V8 13.6 frees a WebAssembly import wrapper twice when one is tiered up
  while code garbage collection frees it on another thread
  ([nodejs/node#66366](https://github.com/nodejs/node/issues/66366), V8 `68210d500a` and `9b8ca54d5a`). Under Node 24
  the threaded runtime's host suites aborted in about 2.5% of runs under load, with
  `Check failed: jit_page.has_value()`, glibc's `corrupted size vs. prev_size` or a segmentation fault; neither
  `--wasm-wrapper-tiering-budget` nor `--no-wasm-code-gc` prevented it. Node 26's V8 14.6 has both fixes. Everything
  that runs Emscripten's output takes the same Node: the wrappers of GLib's tools, Meson's cross `exe_wrapper`, the
  test-program shim and the checks that run what they build. Output written for Node 26 refuses an older one at startup.
- **Floors** raise a browser's minimum where the design needs more than Baseline gives ([below](#the-firefox-floor)).

The derivation (`legacyPackages.<system>.emscriptenMinimumVersions`) holds `date`, `versions.json` and `link-flags`.
With baseline-browser-mapping 2.11.27 (data of 2026-10-01) and Node 26.10.0 they are:

| Target  | Minimum | Source                    |
| ------- | ------- | ------------------------- |
| Chrome  | 123     | Baseline Widely available |
| Firefox | 126     | the floor (Baseline: 124) |
| Safari  | 17.4    | Baseline Widely available |
| Node    | 26.10.0 | the workspace's Node      |

### Only for the environments a link targets

The compiler wrapper's hook (`emscripten-cc-wrapper-hook.sh`) adds the minimums to links only, since emcc warns that a
link setting is ignored on a compile. It reads the link's `-sENVIRONMENT` (the last one given, in either spelling,
bracketed or quoted) and adds Node's minimum only if the link can run under Node and the browsers' only if it can run in
a browser (`web`, `worker`, `webview`); a link that names no environment gets all four. Why: emcc warns about, and
ignores, a minimum for an environment the link excludes. The flags go ahead of the command's own, so a package's own
minimum wins. `checks.toolchain-cross` checks that links get them, compiles don't, and a Worker-only or Node-only link
gets only its own. Builds that call emcc directly use `ibusWeb.toolchain.minimumVersionFlags`.

### The Firefox floor

Firefox's minimum is raised to 126, the first release with `indexedDB.databases()`, which the Worker host uses to list
other versions' engine data ([storage.md](storage.md)). Firefox 124 and 125 together are some 0.02% of users. A floor
only ever raises a minimum: once Baseline reaches 126 it has no effect, so it never needs to be removed by hand.

### What they turn on

`checks.toolchain-cache` records which features the minimums alone switch on, for a main module and a side module linked
without `-mextended-const`, and compares the list with `modules/toolchain/expected-features.txt`. A change in
baseline-browser-mapping's data that moves a feature fails the check and is reviewed. Today:

- **On:** extended-const (Chrome 114, Firefox 112, Safari 17.4). An older baseline-browser-mapping gave Safari 17.2, and
  with `-mextended-const` given Emscripten enables the feature anyway, without a warning; that is why the probe leaves
  the flag out.
- **Off:** growable shared buffers (`-sGROWABLE_ARRAYBUFFERS=2` needs Chrome 144, Firefox 145, Safari 26.2, Node 26),
  Memory64 (Safari has none), and the standard (exnref) encoding of WebAssembly exceptions.

Effect, measured when the minimums replaced Emscripten's defaults (Chrome 85, Firefox 79, Safari 15, Node 18.3):
`ibus-runtime.wasm` was byte for byte the same apart from an embedded store path, and so were the side modules;
`ibus-runtime.js` shrank by 579 bytes (121 gzipped), losing fallbacks for old WebKit; startup was unchanged within
noise.

**Exception encoding.** `-fwasm-exceptions` emits the legacy encoding, which Firefox warns is deprecated for every
Worker that instantiates the runtime. `-sWASM_LEGACY_EXCEPTIONS=0` emits the standard one (`try_table`, exnref), a
compile and link setting that rebuilds every object and the cache. It needs Chrome 137, Firefox 131 and Safari 18.4,
which is Baseline newly available, widely available from about November 2027. `checks.toolchain-exnref` reads exnref's
minimums from Emscripten's feature matrix (`tools/feature_matrix.py`) and fails, asking for the switch, once every
derived minimum reaches them (spec R18).

## The cross package set `pkgsWasm`

WebAssembly builds of nixpkgs packages come from `pkgsWasm` (`ibusWeb.toolchain.pkgsWasm`, exported as
`legacyPackages.<system>.pkgsWasm`): nixpkgs imported with `crossSystem` set to nixpkgs' `wasm32-unknown-none` example
plus `isStatic = true` and `useEmscripten = true`, and `config.replaceCrossStdenv` putting Emscripten in place of the
cross compiler (`modules/toolchain/cross.nix`). Recipes build unmodified wherever they can: their dependencies,
`pkg-config` and their Autotools, Meson and CMake configuration come from nixpkgs' ordinary cross-compilation machinery,
and cross splicing supplies the WebAssembly builds of their dependencies. Why: nixpkgs already knows how to build the
engines and their libraries, and updating the `nixpkgs` input is how their versions move (spec §10.2). zlib and libffi
build from their recipes with no change at all; libhangul's recipe gains only the Hangul engine's patch.

### The compiler wrapper

- `emcc` and `em++` are wrapped by nixpkgs' `cc-wrapper` as a clang (`stdenv.cc.isClang`), with its version taken from
  the clang Emscripten is built against, since cc-wrapper keys clang feature checks off the version. The wrapper adds
  `commonFlags` to every compile and link and the minimum versions to every link (above).
- The wrapper's `--target` and `-nostdlibinc` are removed: emcc chooses its own target and sysroot. The removals fail
  loudly if nixpkgs stops emitting them.
- A `cc-wrapper-hook` drops arguments that clang and lld accept but emcc and wasm-ld reject (`-static-libgcc`,
  `--undefined-version`). Recipes pass them because the wrapper presents Emscripten as clang with lld; nixpkgs' zlib
  passes both.
- The binutils (`emar`, `emranlib`, LLVM's `nm`, `strip`, `objdump` and the rest, `wasm-ld`) are linked under the target
  prefix, since the bintools wrapper wraps only prefixed tools and builds would otherwise fall back to whatever `ar` is
  on `PATH`.
- `libc` is `null`: Emscripten's libc lives in its cache sysroot, which emcc adds to every command itself.
- Hardening is nixpkgs' default list less what clang can't apply for this target, which the compiler declares
  unsupported: `zerocallusedregs`, `pacret` and `shadowstack`, which it rejects, and `stackclashprotection`, which it
  ignores with a warning that fails `-Werror` builds. cc-wrapper drops unsupported flags whatever `NIX_HARDENING_ENABLE`
  holds, so a build that also compiles for the build machine, whose compiler's setup hook may set the variable first,
  still gets this list. cc-wrapper's own rules for the target drop `fortify`, `stackprotector`, `pic` and `pie`;
  libc++'s fast hardening mode and `strictoverflow` apply.
- `isStatic` makes nixpkgs apply its `makeStatic` adapter: static libraries only, every build input propagated,
  `-static` at link time. Engines link their libraries into side modules.
- Emscripten is the build machine's, as `pkgsBuildBuild`'s would be. `buildPackages` would give it a WebAssembly target
  platform, which rehashes it and everything under it (openjdk included), so none of it would come from the binary
  cache.
- `config.allowUnsupportedSystem` is set, because recipes' platform lists predate this target.

`checks.toolchain-cross` builds and runs the probes through the cross stdenv's own `$CC` and `$CXX`, so the wrapper, its
flags, the dropped arguments and the frozen cache are checked together. `checks.toolchain-meson-consumer` builds a Meson
program against `pkgsWasm.zlib` and `pkgsWasm.libffi` through the cross `pkg-config`, with a define passed the way
recipes pass them (`NIX_CFLAGS_COMPILE`) that the program refuses to compile without. `checks.hangul-libhangul-link`
builds against the patched libhangul that `hangul.wasm` links, through the cross `pkg-config` as the engine does, and
composes 한 with it.

### Meson, Autotools and CMake

- **Meson.** nixpkgs' generated cross file reports the platform's kernel as the host system, `none`, and nixpkgs'
  `lib.systems` has no Emscripten kernel. Meson keys Emscripten behaviour on the host system (the `.js` executable
  suffix, GLib's patches), so a setup hook in the cross stdenv (`emscripten-meson-hook.sh`) hands every Meson build a
  second cross file setting `host_machine.system = 'emscripten'` and Node as `exe_wrapper`. Meson reads cross files in
  order with later values winning, so the second carries only what differs. With the exe wrapper Meson can run tests and
  `run()` checks under Node. Both cross files, nixpkgs' (imported from its `pkgs/build-support/lib/meson.nix`) and ours,
  are `ibusWeb.toolchain.mesonCrossFlags`, for configuring by hand; the dev shell's `meson-setup-wasm` uses them.
- **Autotools** and **CMake** still see `wasm32-unknown-none`. Autotools configures as a cross build (`--build` and
  `--host` differ), so configure scripts link their test programs, against the cache's plain variants, but don't run
  them.

`emscripten` as Meson's host system is an identity this project defines; it isn't derived.

### Overlays

Every recipe change for WebAssembly is an overlay in the flake's `overlays` output, applied to `pkgsWasm`, so every
package in the set that depends on the changed one sees the change. Each is gated:

```nix
lib.optionalAttrs (prev.stdenv.hostPlatform.isWasm && (prev.stdenv.hostPlatform.useEmscripten or false)) { … }
```

so it never reaches a native or WASI package set and the overlays are safe to export. The gate reads only the platform:
reading `stdenv.cc` evaluates the wrapped compiler, whose `buildPackages` splicing reaches back into `pkgsWasm` and
recurses. `checks.toolchain-cross` evaluates a probe overlay and asserts it applies to `pkgsWasm` and not to its
`buildPackages`.

One overlay per component, `modules/<component>/overlay.nix` defining `flake.overlays.<component>`, with its patches in
`modules/<component>/patches/`. Today there is one, `flake.overlays.glib` ([glib.md](glib.md#the-overlay)). Overlays
only drop desktop-only inputs and features, drop the nixpkgs patches that serve only those, and append our patch layers
after nixpkgs' remaining patches. Dependencies are never swapped by hand, since cross splicing supplies them, and a
patched package is never defined under another name, because dependents inside `pkgsWasm` would not see it.

### Outputs

- `legacyPackages.<system>.pkgsWasm` is the cross set; the WebAssembly build of a nixpkgs package is `pkgsWasm.<name>`.
  `legacyPackages` also holds the toolchain pieces `emscriptenCache` and `emscriptenMinimumVersions`, and other sets of
  this project's outputs that are better kept together than flat in `packages`, such as `npm`, the npm tarballs
  (`docs/tooling.md`).
- `packages.<system>` is not a mirror of `pkgsWasm`. It holds this project's own derivations: the runtime's artifacts
  and pinned tools of our own, such as `baseline-browser-mapping` and `hk-pkl`.

## Dynamic linking

The runtime, `ibus-runtime.wasm`, is an Emscripten main module linked with `em++` and `-sMAIN_MODULE=2`; each engine is
a side module (`-sSIDE_MODULE=1`) that the runtime `dlopen`s (spec D8). The main module carries GLib, libffi,
`libibus-web`, libc and the C++ runtime (libc++, libc++abi, libunwind); side modules take those from it and link their
other static libraries in themselves. Why one shared main module: GLib and the C++ runtime are loaded once per Worker
rather than linked into every engine, and every engine sees the one GLib, whose type system and main context are global
state.

`-sMAIN_MODULE=2` keeps only what the export list names, so code nothing exports is dropped. The list is derived from
the build, never written by hand: the symbols each carried library defines with default visibility (GLib and
`libibus-web` are built with everything else hidden), with each library's version read from its headers, `.pc` file or
Emscripten's records (`runtime/ibus-runtime/exports.nix`). `checks.ibus-runtime-exports` checks the manifest against the
libraries and `checks.ibus-runtime-side-imports` every side module's imports against it. Side modules are built by
`ibusWeb.runtime.mkSideModule`, which refuses a static library the runtime already carries: a second GLib in a side
module would have state of its own. The runtime's link, memory and pool are described in [runtime.md](runtime.md).

### What was established

Dynamic linking with pthreads is labelled experimental by Emscripten itself, and the design's pool exists before any
side module loads, the harder case. So it was proven before anything was built on it (spec R3), first with Emscripten
6.0.9, LLVM 22.1.8 and Node 24.19.0 under Node, with a C++ main module linked
`-sMAIN_MODULE=1 -sPTHREAD_POOL_SIZE=2 -sNODERAWFS=1` that `dlopen`ed five side modules after its pool existed. All five
passed on the first successful build:

- a C side module calling the main module's libc;
- side-module code running on a pool thread created before the `dlopen`;
- a C++ side module throwing and catching an exception inside itself, on the main module's libc++;
- an exception thrown in a side module and caught in the main module (one exception, no nesting, no concurrent throws,
  no C frames in between);
- a static library (libhangul) linked into a side module, the shape of an engine.

The same cases then ran in the runtime's own configuration, `-sMAIN_MODULE=2` with WasmFS, under Node and in Chromium
149 and Firefox 151: side modules loaded into a runtime whose pool already runs, threads on pool Workers calling into
them, a C++ exception thrown in a side module and caught in the runtime, and `dlopen()` while other threads run. The
last needed an Emscripten fix: a joined thread's late "finished" message could mark a new thread that reused its
`pthread_t`, so `dlopen()`'s sync skipped it and its calls into the new module trapped
([draft](upstream/emscripten-pthread-finished-mark-reused.md)). WebKit isn't run. Today `checks.ibus-runtime-load`
covers the C, C++, exception and static-library cases against the runtime, and the Worker host's checks the threaded
ones ([worker-host.md](worker-host.md)).

Facts that shape the links:

- With `-fwasm-exceptions`, Emscripten 6.0.9 uses the legacy exception instructions and its `*-legacyexcept` library
  variants (see [exception encoding](#what-they-turn-on)).
- A main module that carries `-fwasm-exceptions` code links with `em++` ([above](#compiler-flags)).

### `dlsym(RTLD_NEXT)`

Emscripten's `dlfcn.h` defines `RTLD_NEXT`, but nothing finds a symbol through it. In a static link `dlsym()` is a stub
that fails for every handle, and a maintainer has said `RTLD_NEXT` is unsupported
([#23302](https://github.com/emscripten-core/emscripten/issues/23302#issuecomment-2571756300)). Under `-sMAIN_MODULE`,
though, `dlsym(RTLD_NEXT, …)` doesn't fail cleanly: it aborts on an assertion, or throws a `TypeError` without
assertions. That narrower bug has a draft, [`emscripten-dlsym-rtld-next.md`](upstream/emscripten-dlsym-rtld-next.md).
GLib's build detected `HAVE_RTLD_NEXT` from the macro alone; its patch series leaves it unset on Emscripten
([glib.md](glib.md#other-changes)). Only GLib's tests used it, to wrap a libc function.

## Derive, don't hardcode

Versions, target prefixes, triples, store paths and symbol lists come from Nix evaluation or from the build, never from
literals:

- Emscripten's version, and the clang version the wrapper reports, come from the Emscripten derivation
  (`emscripten.version`, `emscripten.llvmEnv`).
- The target prefix comes from `hostPlatform.config`; the cross files from nixpkgs' own Meson support.
- The minimum versions come from baseline-browser-mapping's data and the workspace's Node.
- The runtime's export list comes from the libraries it links; library versions from their headers and `.pc` files.
- GLib's tool list comes from what its build installs ([glib.md](glib.md#tools)).

Where a build edits a nixpkgs script or removes something nixpkgs adds, it first asserts the thing is there, so a change
upstream fails evaluation or the build instead of silently doing nothing.

## Flake layout

The flake is dendritic: `flake.nix` holds only its inputs and hands every `.nix` file under `modules/`, `packages/`,
`tools/`, `runtime/`, `engines/` and `examples/` to flake-parts through import-tree. Every such file is a flake-parts
module (a path containing `/_` is skipped, for `.nix` files that aren't modules). Modules never import each other; they
share values only through per-system `ibusWeb.*` options (`ibusWeb.toolchain.*`, `ibusWeb.runtime.*`,
`ibusWeb.typescript.*`, `ibusWeb.testing.*`, …) and flake outputs.

- Each component's Nix sits in its directory, in files named for their role: `module.nix` (its packages, outputs and
  dev-shell setup), `options.nix` (options it declares for other modules), `checks.nix`, `overlay.nix` (its overlay on
  `pkgsWasm`), and `_<name>.nix` for a plain `callPackage` recipe, which import-tree skips. A module with more than one
  job splits into modules named for each (`archives.nix`, `exports.nix`, `cache.nix`), and a job's module may define the
  checks that need its own bindings. A check with fixtures of its own gets a directory holding its `checks.nix` beside
  them, and `patches/` holds a component's patches with a README of their provenance.
- `modules/` holds what components share: `toolchain/`, `emscripten/`, `glib/` and `baseline-browser-mapping/`, which
  this page covers; `engines/`, the API engines are built and checked with; `typescript/` and `testing/`; and `flake/`
  (systems, dev shell, CI, hk, generated files, and `ibusWeb.lib`, the helpers modules share).
- `runtime/<part>/`, `packages/<name>/`, `tools/<name>/`, `engines/<name>/` and `examples/<name>/` each hold one
  component: its sources, its Nix and its tests.
- Non-Nix files sit beside the module that uses them, under plain names.

**Inputs** come from FlakeHub when the project publishes there and its latest FlakeHub release is current with upstream
(nixpkgs, flake-parts, github-actions-nix); otherwise from GitHub. nixpkgs follows FlakeHub's rolling `0.1` release of
nixos-unstable; moving it is an ordinary `nix flake update`, and is how every dependency's version moves.

## Supported systems

The flake evaluates for `aarch64-darwin`, `aarch64-linux` and `x86_64-linux`, from the `nix-systems/triplet` input.
Darwin was left out while WebAssembly builds inherited the native `hostPlatform`, under which recipes restricted to
Linux refused to evaluate; `pkgsWasm`'s host platform is WebAssembly, so that reason is gone (spec R17). CI runs
`nix flake check` for `x86_64-linux` only, on GitHub's runners ([tooling.md](tooling.md)); the other systems evaluate
but their builds aren't exercised. See [known-gaps.md](known-gaps.md#toolchain).

## Development shell and editor

The dev shell carries the cross compiler and binutils, the cross `pkg-config` (searching the
`ibusWeb.toolchain.devLibraries` packages), Meson and Ninja, and clangd from the LLVM emcc drives, told to trust the
cross compiler as a query driver. A generated `.clangd` gives loose sources the cross compiler, `commonFlags`, LLVM's
resource directory and the dev libraries' include paths; `checks.toolchain-clangd` checks that every C and C++ source in
the repository parses cleanly under it. The rest of the editor and formatting setup is in [tooling.md](tooling.md).

## Checks

| Check                      | What it checks                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `toolchain-cache`          | probes link from the frozen cache alone; an uncached variant fails; the features the minimums enable |
| `toolchain-exnref`         | fails once every minimum version supports the standard exception encoding                            |
| `toolchain-cross`          | the cross stdenv's wrapper, flags, dropped arguments, minimum versions per environment, overlay gate |
| `toolchain-meson-consumer` | a Meson build through the cross `pkg-config` against `pkgsWasm.zlib` and `pkgsWasm.libffi`           |
| `hangul-libhangul-link`    | the patched libhangul the Hangul engine links, found through the cross `pkg-config`                  |
| `emscripten-fixes`         | the behaviour each Emscripten patch restores                                                         |
| `toolchain-clangd`         | every C and C++ source parses under the editor configuration                                         |
