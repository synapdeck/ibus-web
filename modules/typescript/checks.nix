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

      inherit (config.ibusWeb.typescript) publishedPackages;

      # Some packages hold files a Nix build copies in; the rest are TypeScript.
      isNixBuilt = dir: (lib.importJSON (root + "/${dir}/package.json")).ibusWeb.nixBuilt or false;
      published = lib.filter (dir: !(isNixBuilt dir)) publishedPackages;
      publishedNixBuilt = lib.filter isNixBuilt publishedPackages;

      # What every published package states, whatever it holds.
      commonProblems =
        dir: manifest:
        let
          homepage = manifest.homepage or "";
        in
        lib.optional (!(builtins.pathExists (root + "/${dir}/README.md"))) "has no README.md"
        ++ lib.optional (!(manifest ? description)) "has no description"
        ++ lib.optional (
          !(
            lib.hasPrefix docsBase homepage
            && builtins.pathExists (root + "/${lib.removePrefix docsBase homepage}")
          )
        ) "homepage isn't a page of this repository"
        ++ lib.optional ((manifest.keywords or [ ]) == [ ]) "has no keywords";

      problemsOf =
        dir:
        let
          manifest = lib.importJSON (root + "/${dir}/package.json");

          # The packages target the Node the workspace builds with. Only its
          # major version is stated, so a nixpkgs patch release of Node doesn't
          # fail this.
          node = ">=${lib.versions.major nodejs.version}";
        in
        map (problem: "${dir}: ${problem}") (
          commonProblems dir manifest
          ++ lib.optional (
            (manifest.license or null) != "MIT OR Apache-2.0"
          ) "isn't licensed MIT OR Apache-2.0"
          ++ lib.optional (!(manifest ? sideEffects)) "doesn't declare sideEffects"
          ++ lib.optional ((manifest.engines.node or null) != node) "engines.node isn't \"${node}\""
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

      # A Nix-built package holds only what its build copies in. Its
      # tarball's build holds its license to its contents'.
      nixBuiltProblemsOf =
        dir:
        let
          manifest = lib.importJSON (root + "/${dir}/package.json");
        in
        map (problem: "${dir}: ${problem}") (
          commonProblems dir manifest
          ++ lib.optional (!(manifest ? license)) "has no license"
          ++ lib.optional (
            (manifest.files or [ ]) != [
              "dist"
              "LICENSES"
            ]
          ) "doesn't pack exactly dist and LICENSES"
          ++ lib.optional (manifest ? scripts) "has scripts, though Nix builds its contents"
        );

      problems = lib.concatMap problemsOf published ++ lib.concatMap nixBuiltProblemsOf publishedNixBuilt;
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
