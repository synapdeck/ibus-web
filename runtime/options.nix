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
      exportList = lib.mkOption {
        type = lib.types.package;
        description = "The runtime's export list, exports.txt: what side modules may import from it, versioned by the runtime ABI (passthru.abi).";
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
