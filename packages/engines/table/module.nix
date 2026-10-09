# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      # The engine and the X-SAMPA table, and the LaTeX table's data. MARISA,
      # linked into the module, has no text in the repository: it ships its
      # own, from its source.
      licenses = [
        "MIT"
        "Apache-2.0"
        "W3C"
      ];

      marisaLicense = "LICENSES/marisa/COPYING.md";
    in
    {
      # The module's distribution as dist/, with the licence texts.
      ibusWeb.typescript.npmPackages.engine-table = config.ibusWeb.typescript.npmTarball {
        name = "ibus-web-npm-engine-table";

        src = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [
            ./package.json
            ./README.md
          ];
        };

        files = {
          dist = config.packages.ibus-web-table-dist;
          ${marisaLicense} = "${pkgs.srcOnly config.ibusWeb.toolchain.pkgsWasm.marisa}/COPYING.md";
        };
        inherit licenses;
        license = config.ibusWeb.engines.table.module.meta.license.spdxId;

        # The exports name the rest; the data archives' names are hashes.
        expect = map (id: "LICENSES/${id}.txt") licenses ++ [ marisaLicense ];
      };
    };
}
