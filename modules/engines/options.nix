# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.engines.mkEngineManifest = lib.mkOption {
      type = lib.types.functionTo lib.types.package;
      description = ''
        Build an engine distribution from its side module, data closure, thread share and heap budget.
        Each store path of the closure but the module's own becomes a Brotli-compressed pax archive
        whose entries are named from /nix/store (`<hash>-<name>/...`, or the single file), with hard
        links stored as files; the build fails if a symbolic link in the closure leads outside it.
        `engines` lists the module's engine descriptors, the first being its default, either as Nix
        attribute sets or as a JSON file holding the array.
      '';
    };
    options.ibusWeb.engines.ibusTest = lib.mkOption {
      type = lib.types.functionTo lib.types.package;
      description = "Build a Linux native/WASM trace check from name, nativeConfig, module, settingsSchemaDir, and traces.";
    };
    options.ibusWeb.engines.castAudit = lib.mkOption {
      type = lib.types.functionTo lib.types.package;
      description = ''
        Audit strict function-pointer casts: { name, src, sources ? [ ], sourcesFrom ? null,
        cflags ? "", buildInputs ? [ ], pkgConfigModules ? [ ], allowList }. sourcesFrom,
        when given, is a shell command printing the sources to audit in place of sources.
        Produces report.json and report.txt and fails unless the findings equal the JSONC
        allow-list.
      '';
    };
  };
}
