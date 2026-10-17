# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-3.0-or-later
{
  perSystem =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      dist = config.packages.ibus-web-rime-dist;
      ids = lib.unique (map (license: license.spdxId) dist.licenses);

      # The texts the repository has; for the rest, which nothing in the
      # repository is licensed under, upstream's copy where the distribution
      # has one, else nixpkgs' copy of the SPDX list.
      licenses = lib.filter (id: builtins.pathExists ../../../LICENSES/${id}.txt) ids;
      otherTexts = lib.listToAttrs (
        map (
          id:
          lib.nameValuePair "LICENSES/${id}.txt" (
            dist.licenseTexts.${id} or "${pkgs.spdx-license-list-data.text}/text/${id}.txt"
          )
        ) (lib.subtractLists licenses ids)
      );

      # The module's distribution as dist/, with every licence text and the
      # upstream copyright notices. A distribution built with fewer schemas
      # packs the same way, for the check that packing follows the schema
      # list: the README, description, licence and notices stay the full
      # module's, so that tarball is not one to publish.
      tarball = lib.makeOverridable (
        {
          schemas ? null,
        }:
        config.ibusWeb.typescript.npmTarball {
          name = "ibus-web-npm-engine-rime";

          src = lib.fileset.toSource {
            root = ./.;
            fileset = lib.fileset.unions [
              ./package.json
              ./README.md
            ];
          };

          files =
            dist.notices
            // otherTexts
            // {
              dist = dist.override { inherit schemas; };
            };
          inherit licenses;
          # librime-octagram's GPL takes in every other component's license and
          # the data's.
          license = config.ibusWeb.lib.spdxSummary "GPL-3.0-only" dist.licenses;

          # The exports name the rest; the data archives' names are hashes.
          expect = map (id: "LICENSES/${id}.txt") ids ++ lib.attrNames dist.notices;
        }
      ) { };
    in
    {
      ibusWeb.typescript.npmPackages.engine-rime = tarball;
    };
}
