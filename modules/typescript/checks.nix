# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{ lib, ... }:
{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb.typescript) nodejs;

      root = ../..;
      docsBase = "https://github.com/synapdeck/ibus-web/blob/master/";

      # Every package under packages/ that npm may publish.
      published = lib.filter (dir: !((lib.importJSON (root + "/${dir}/package.json")).private or false)) (
        map (name: "packages/${name}") (
          lib.attrNames (
            lib.filterAttrs (_: type: type == "directory") (builtins.readDir (root + "/packages"))
          )
        )
      );

      problemsOf =
        dir:
        let
          manifest = lib.importJSON (root + "/${dir}/package.json");
          homepage = manifest.homepage or "";

          # The packages target the Node the workspace builds with. Only its
          # major version is stated, so a nixpkgs patch release of Node doesn't
          # fail this.
          node = ">=${lib.versions.major nodejs.version}";
        in
        map (problem: "${dir}: ${problem}") (
          lib.optional (!(builtins.pathExists (root + "/${dir}/README.md"))) "has no README.md"
          ++ lib.optional (!(manifest ? description)) "has no description"
          ++ lib.optional (
            (manifest.license or null) != "MIT OR Apache-2.0"
          ) "isn't licensed MIT OR Apache-2.0"
          ++ lib.optional (
            !(
              lib.hasPrefix docsBase homepage
              && builtins.pathExists (root + "/${lib.removePrefix docsBase homepage}")
            )
          ) "homepage isn't a page of this repository"
          ++ lib.optional (!(manifest ? sideEffects)) "doesn't declare sideEffects"
          ++ lib.optional ((manifest.engines.node or null) != node) "engines.node isn't \"${node}\""
          ++ lib.optional ((manifest.keywords or [ ]) == [ ]) "has no keywords"
          ++ lib.optional (
            (manifest.scripts.prepack or null) != "node ../../tools/pack-licenses/cli.ts prepack"
            || (manifest.scripts.postpack or null) != "node ../../tools/pack-licenses/cli.ts postpack"
          ) "doesn't pack its licenses with tools/pack-licenses"
          ++ map (entry: "doesn't pack ${entry}") (
            lib.filter (entry: !(lib.elem entry (manifest.files or [ ]))) [
              "LICENSES"
              "LICENSE-MIT"
              "LICENSE-APACHE"
            ]
          )
        );

      problems = lib.concatMap problemsOf published;
    in
    {
      checks.typescript-package-metadata = pkgs.runCommand "ibus-web-typescript-package-metadata" { } (
        if problems == [ ] then
          "touch $out"
        else
          lib.concatMapStrings (problem: "echo ${lib.escapeShellArg problem} >&2\n") problems + "exit 1\n"
      );
    };
}
