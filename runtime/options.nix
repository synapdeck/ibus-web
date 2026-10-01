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
      linkFlags = lib.mkOption {
        type = lib.types.str;
        description = "ibus-runtime's link flags but for its export list: toolchain.runtimeMainFlags and the settings that shape its memory, threads and JavaScript.";
      };
      exportList = lib.mkOption {
        type = lib.types.package;
        description = "The runtime's export manifest: exports.txt, what side modules may import from it, grouped by library, and exports.json, the runtime ABI and each library's name, version and symbol count, which together identify the runtime's ABI.";
      };
      checkSideModuleImports = lib.mkOption {
        type = lib.types.functionTo lib.types.package;
        description = "Given { name, modules }, a check that fails if any of the side modules (.wasm paths) imports a symbol the export list lacks.";
      };
      nodeHarness = lib.mkOption {
        type = lib.types.package;
        description = "harness.mjs, which drives the runtime at the C level from Node, and the errno.json it reads.";
      };
    };
  };
}
