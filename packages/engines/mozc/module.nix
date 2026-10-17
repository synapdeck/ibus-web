# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: BSD-3-Clause
{
  perSystem =
    { config, lib, ... }:
    let
      mozc = config.ibusWeb.toolchain.pkgsWasm.mozc-ut;
      ids = map (license: license.spdxId) mozc.meta.license;

      # The texts the repository has. Mozc's credits carry the notices of
      # every component it names, and each UT dictionary states its own terms.
      licenses = lib.filter (id: builtins.pathExists ../../../LICENSES/${id}.txt) ids;

      notices = {
        "LICENSES/mozc/LICENSE" = "${mozc.src}/LICENSE";
        "LICENSES/mozc/credits_en.html" = "${mozc.src}/src/data/installer/credits_en.html";
      }
      // lib.mapAttrs' (
        name: dictionary: lib.nameValuePair "LICENSES/${name}/LICENSE" "${dictionary.src}/LICENSE"
      ) mozc.dictionaries;
    in
    {
      # The module's distribution as dist/, with the licence texts.
      ibusWeb.typescript.npmPackages.engine-mozc = config.ibusWeb.typescript.npmTarball {
        name = "ibus-web-npm-engine-mozc";

        src = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [
            ./package.json
            ./README.md
          ];
        };

        files = notices // {
          dist = config.packages.ibus-web-mozc-dist;
        };
        inherit licenses;
        # The dictionaries' GPL takes in Mozc's permissive licenses and its
        # data's, all but Apache-2.0, which version 2 can't.
        license = config.ibusWeb.lib.spdxSummary "GPL-2.0-only AND Apache-2.0 AND CC-BY-SA-4.0" mozc.meta.license;

        # The exports name the rest; the data archives' names are hashes.
        expect = map (id: "LICENSES/${id}.txt") licenses ++ lib.attrNames notices;
      };
    };
}
