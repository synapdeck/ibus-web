# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-2.0-or-later
{
  perSystem =
    { config, lib, ... }:
    let
      inherit (config.ibusWeb.engines.m17n) package;

      # ibus-m17n's, and those of m17n-lib, linked in, and m17n-db, the data.
      licenses = map (license: license.spdxId) (lib.toList package.meta.license);
    in
    {
      # The module's distribution as dist/, with the licence texts.
      ibusWeb.typescript.npmPackages.engine-m17n = config.ibusWeb.typescript.npmTarball {
        name = "ibus-web-npm-engine-m17n";

        src = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [
            ./package.json
            ./README.md
          ];
        };

        files.dist = config.packages.ibus-web-m17n-dist;
        inherit licenses;
        license = config.ibusWeb.lib.spdxExpression package.meta.license;

        # The exports name the rest; the data archives' names are hashes.
        expect = map (id: "LICENSES/${id}.txt") licenses;
      };
    };
}
