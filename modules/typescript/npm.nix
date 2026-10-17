# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{ lib, ... }:
{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb.typescript) npmPackages npmTarball workspaceFor;

      root = ../..;

      packagesIn =
        parent:
        map (name: "${parent}/${name}") (
          lib.attrNames (
            lib.filterAttrs (
              name: type: type == "directory" && builtins.pathExists (root + "/${parent}/${name}/package.json")
            ) (builtins.readDir (root + "/${parent}"))
          )
        );

      isPublished = dir: !((lib.importJSON (root + "/${dir}/package.json")).private or false);

      publishedPackages = lib.filter isPublished (packagesIn "packages" ++ packagesIn "packages/engines");
      isNixBuilt = dir: (lib.importJSON (root + "/${dir}/package.json")).ibusWeb.nixBuilt or false;

      # Each packed from its build in the workspace, so its scripts, and pnpm's
      # rewriting of workspace: and catalog: versions, see the workspace.
      workspaceTarballs = lib.listToAttrs (
        map (
          dir:
          lib.nameValuePair (baseNameOf dir) (npmTarball {
            name = "ibus-web-npm-${baseNameOf dir}";
            src = workspaceFor [ dir ];
            inherit dir;
            # The workspace holds sources alone, so a README's edit rebuilds
            # no workspace.
            files."README.md" = root + "/${dir}/README.md";

            # tools/pack-licenses adds these whatever the bundle holds.
            expect = [
              "LICENSE-MIT"
              "LICENSE-APACHE"
            ];
          })
        ) (lib.filter (dir: !(isNixBuilt dir)) publishedPackages)
      );

      all = pkgs.symlinkJoin {
        name = "ibus-web-npm";
        paths = lib.attrValues npmPackages;
      };
    in
    {
      ibusWeb.typescript = {
        inherit publishedPackages;
        npmPackages = workspaceTarballs;
      };

      legacyPackages.npm = lib.recurseIntoAttrs (npmPackages // { inherit all; });

      checks.typescript-npm = all;
    };
}
