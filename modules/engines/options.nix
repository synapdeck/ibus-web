# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.engines.hangul = lib.mkOption {
      type = lib.types.package;
      description = "The Hangul side module and its data/usr/share tree.";
    };
    options.ibusWeb.engines.ibusTest = lib.mkOption {
      type = lib.types.functionTo lib.types.package;
      description = "Build a Linux native/WASM trace check from name, nativeConfig, module, data, and traces.";
    };
    options.ibusWeb.engines.castAudit = lib.mkOption {
      type = lib.types.functionTo lib.types.package;
      description = ''
        Audit strict function-pointer casts: { name, src, sources, cflags ? "",
        buildInputs ? [ ], pkgConfigModules ? [ ], allowList }. Produces report.json
        and report.txt and fails unless the findings equal the JSONC allow-list.
      '';
    };
  };
}
