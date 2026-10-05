# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.engines.mkEngineManifest = lib.mkOption {
      type = lib.types.functionTo lib.types.package;
      description = ''
        Build an engine distribution from its side module, data closure, thread share and heap budget.
        Each store path of the closure but the module's own becomes a Brotli-compressed ustar archive
        whose entries are named from /nix/store (`<hash>-<name>/...`, or the single file), with hard
        links stored as files; the build fails if a symbolic link in the closure leads outside it.
      '';
    };
    options.ibusWeb.engines.hangul = lib.mkOption {
      type = lib.types.package;
      description = "The Hangul side module with data-only store references.";
    };
    options.ibusWeb.engines.ibusTest = lib.mkOption {
      type = lib.types.functionTo lib.types.package;
      description = "Build a Linux native/WASM trace check from name, nativeConfig, module, settingsSchemaDir, and traces.";
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
