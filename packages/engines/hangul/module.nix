# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, lib, ... }:
    let
      hangul = config.ibusWeb.engines.hangul;

      # The module links libhangul, and the data closure carries its tables.
      licenses = lib.unique (
        map (license: license.spdxId) (
          lib.concatMap lib.toList [
            hangul.meta.license
            hangul.libhangul.meta.license
          ]
        )
      );
    in
    {
      # The engine's distribution as dist/, with the license texts.
      ibusWeb.typescript.npmPackages.engine-hangul = config.ibusWeb.typescript.npmTarball {
        name = "ibus-web-npm-engine-hangul";

        src = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [
            ./package.json
            ./README.md
          ];
        };

        files.dist = config.packages.ibus-web-hangul-dist;
        inherit licenses;

        expect = [
          "dist/manifest.json"
          "dist/hangul.wasm"
          "dist/settings.json"
        ]
        ++ map (id: "LICENSES/${id}.txt") licenses;
      };
    };
}
