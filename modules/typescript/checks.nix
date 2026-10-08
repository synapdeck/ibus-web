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

      # The package directories in a directory, private or not.
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

      # Every package under packages/ that npm may publish: the TypeScript
      # packages, and the engines whose builds packages/engines/ packs.
      published = lib.filter isPublished (packagesIn "packages");
      publishedEngines = lib.filter isPublished (packagesIn "packages/engines");

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

      # An engine package holds only what its Nix build copies in, under the
      # license of the engine's module as a whole.
      engineProblemsOf =
        dir:
        let
          manifest = lib.importJSON (root + "/${dir}/package.json");
          engine = config.ibusWeb.engines.${baseNameOf dir};
          license = lib.concatMapStringsSep " AND " (license: license.spdxId) (
            lib.toList engine.meta.license
          );
        in
        map (problem: "${dir}: ${problem}") (
          commonProblems dir manifest
          ++ lib.optional (
            (manifest.license or null) != license
          ) "isn't licensed ${license}, as the engine is"
          ++ lib.optional (
            (manifest.files or [ ]) != [
              "dist"
              "LICENSES"
            ]
          ) "doesn't pack exactly dist and LICENSES"
          ++ lib.optional (manifest ? scripts) "has scripts, though Nix builds its contents"
        );

      problems = lib.concatMap problemsOf published ++ lib.concatMap engineProblemsOf publishedEngines;
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
