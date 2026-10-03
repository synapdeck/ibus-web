# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.runtime = {
      libibusWeb = lib.mkOption {
        type = lib.types.package;
        description = "libibus-web for pkgsWasm: the static library the Worker host drives, its header and its pkg-config file.";
      };
      wasmfsIdb = lib.mkOption {
        type = lib.types.package;
        description = "The WasmFS IndexedDB backend: libwasmfs-idb.a and its header, with passthru.jsLibrary, the JavaScript library its links pass with --js-library, and passthru.cflags, the -I flag for the WasmFS internal headers it was compiled against.";
      };
      wasmfsIdbTestLibraries = lib.mkOption {
        type = lib.types.listOf lib.types.path;
        description = "The JavaScript libraries wasmfs-idb's test programs link with --js-library besides the backend's own; each one's __deps are checked and it is type-checked.";
      };
      libraryDeps = lib.mkOption {
        type = lib.types.str;
        description = "The JavaScript library checker, a Node script run as `node <it> check <library.js> <emscripten root>` or `node <it> emit <library.js> <emscripten root> <directory>`, beside the dependencies it imports and nothing else of the workspace, so editing another source rebuilds nothing that runs it.";
      };
      ibusRuntime = lib.mkOption {
        type = lib.types.package;
        description = "ibus-runtime: the main module engines' side modules load into, as ibus-runtime.js and ibus-runtime.wasm, with its export list. It carries wasmfsIdb, whose header's API is on the list.";
      };
      ibusRuntimeAsserting = lib.mkOption {
        type = lib.types.package;
        description = "ibus-runtime linked with Emscripten's runtime assertions, for checks.";
      };
      threadPool = {
        shares = lib.mkOption {
          type = lib.types.attrsOf lib.types.ints.positive;
          description = "The threads ibus-runtime's pthread pool is sized for, by what starts them: how many each is planned to have alive at once. GLib's is what one GTask in flight keeps alive, GTasks in flight at once taking more; the storage backends' is a thread per backend, two per engine.";
        };
        size = lib.mkOption {
          type = lib.types.ints.positive;
          description = "The pthread pool's size at start: the sum of its shares plus lowWater spare Workers. Creating a thread when no Worker is idle fails with EAGAIN in a browser.";
        };
        planned = lib.mkOption {
          type = lib.types.ints.positive;
          description = "The sum of the pool's shares: the threads planned to be alive at once.";
        };
        lowWater = lib.mkOption {
          type = lib.types.ints.positive;
          description = "The spare Workers the pool starts with beyond its shares, and the idle Workers a Worker host tops it back up to whenever no request is pending; threads alive within the shares leave at least this many idle, so the pool grows only past them.";
        };
      };
      memory = {
        minimum = lib.mkOption {
          type = lib.types.ints.positive;
          description = "The least memory, in bytes, a host may make for ibus-runtime: the initial size of the memory it imports. Linked without memory growth, the runtime never grows the memory its host makes at its engine's size; a full heap aborts.";
        };
        maximum = lib.mkOption {
          type = lib.types.ints.positive;
          description = "The most memory, in bytes, a host may make for ibus-runtime: the maximum its memory import declares.";
        };
      };
      linkFlags = lib.mkOption {
        type = lib.types.str;
        description = "ibus-runtime's link flags but for its export list: toolchain.runtimeMainFlags and the settings that shape its memory, threads and JavaScript. Its memory, imported and never grown, is declared from memory.minimum to memory.maximum.";
      };
      exportList = lib.mkOption {
        type = lib.types.package;
        description = "The runtime's export manifest: exports.txt, what side modules may import from it, grouped by library, and exports.json, the runtime ABI and each library's name, version, symbol count and symbols, which together identify the runtime's ABI.";
      };
      checkSideModuleImports = lib.mkOption {
        type = lib.types.functionTo lib.types.package;
        description = "Given { name, modules }, a check that fails if any of the side modules (.wasm paths) imports a symbol the export list lacks.";
      };
      mkSideModule = lib.mkOption {
        type = lib.types.functionTo lib.types.package;
        description = ''
          Given { name, src, sources, buildInputs ? [ ], pkgConfigModules ? [ ] }, builds the
          side module name.wasm from sources (paths relative to src; .c with $CC,
          .cpp/.cc/.cxx with $CXX, and nothing else) against libibus-web, with
          toolchain.sideModuleFlags. pkgConfigModules name static libraries, from
          buildInputs, that are compiled against and linked into the module. The result has
          passthru.wasm, the module's path, and passthru.importsCheck, its
          checkSideModuleImports check.
        '';
      };
      sideModuleLibraryGuard = lib.mkOption {
        type = lib.types.path;
        description = "Shell functions checking that a side module's link flags do not link a second copy of the runtime's libraries.";
      };
      nodeHarness = lib.mkOption {
        type = lib.types.package;
        description = "ibus-runtime's load tests' harness, harness.ts, which drives the runtime at the C level from Node, and what it reads: memory.json (the least and the most memory the runtime takes), constants.json (the header's pumpError) and errno.json (Emscripten's errno values, which the Worker host's tests read too).";
      };
      installArchives = lib.mkOption {
        type = lib.types.package;
        description = "Archives for testing engine data installs: tree.tar, a deterministic ustar of nested directories and files spanning several storage chunks; tree.json, its version (from its bytes), its unpacked size in bytes and its listing; listing.txt, the listing alone, one `PATH<TAB>d` or `PATH<TAB>f SIZE SHA256` line per entry, sorted bytewise; and archives the installer must refuse: absolute.tar, dotdot.tar, symlink.tar, hardlink.tar, fifo.tar (each a valid file, then the refused member) and corrupt.tar (tree.tar with a header's checksum broken).";
      };
    };
  };
}
