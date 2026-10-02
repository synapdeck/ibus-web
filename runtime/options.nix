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
      ibusRuntime = lib.mkOption {
        type = lib.types.package;
        description = "ibus-runtime: the main module engines' side modules load into, as ibus-runtime.js and ibus-runtime.wasm, with its export list.";
      };
      ibusRuntimeAsserting = lib.mkOption {
        type = lib.types.package;
        description = "ibus-runtime linked with Emscripten's runtime assertions, for checks.";
      };
      threadPool = {
        shares = lib.mkOption {
          type = lib.types.attrsOf lib.types.ints.positive;
          description = "The threads ibus-runtime's pthread pool is sized for, by what starts them: how many each is planned to have alive at once. GLib's is what one GTask in flight keeps alive; GTasks in flight at once take more.";
        };
        size = lib.mkOption {
          type = lib.types.ints.positive;
          description = "The pthread pool's size at start: the sum of its shares plus lowWater spare Workers. Creating a thread when no Worker is idle fails with EAGAIN in a browser.";
        };
        lowWater = lib.mkOption {
          type = lib.types.ints.positive;
          description = "The spare Workers the pool starts with beyond its shares, and the idle Workers a Worker host tops it back up to whenever no request is pending; threads alive within the shares leave at least this many idle, so the pool grows only past them.";
        };
      };
      link = lib.mkOption {
        type = lib.types.functionTo lib.types.package;
        description = "Given { pname, extraFlags }, links ibus-runtime as the package does, with extraFlags after its own flags, which they override.";
      };
      memory.minimum = lib.mkOption {
        type = lib.types.ints.positive;
        description = "The least memory, in bytes, a host may make for ibus-runtime: the initial size of the memory it imports. The host makes each runtime's memory at its engine's size with its maximum at that size, so it never grows.";
      };
      linkFlags = lib.mkOption {
        type = lib.types.str;
        description = "ibus-runtime's link flags but for its export list: toolchain.runtimeMainFlags and the settings that shape its memory, threads and JavaScript.";
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
          Given { name, src, sources }, builds the side module name.wasm from sources (paths
          relative to src; .c with $CC, .cpp/.cc/.cxx with $CXX, and nothing else) against libibus-web, with
          toolchain.sideModuleFlags. The result has passthru.wasm, the module's path, and
          passthru.importsCheck, its checkSideModuleImports check.
        '';
      };
      nodeHarness = lib.mkOption {
        type = lib.types.package;
        description = "harness.mjs, which drives the runtime at the C level from Node, and the errno.json and memory.json (the runtime's least memory) it reads.";
      };
      nodeTimeout = lib.mkOption {
        type = lib.types.str;
        description = "A command prefix that bounds a Node check's run from outside Node.";
      };
    };
  };
}
