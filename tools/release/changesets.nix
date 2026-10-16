# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{ inputs, ... }:
{
  perSystem =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      inherit (config.ibusWeb) testing typescript;

      nameOf = dir: (lib.importJSON (../.. + "/${dir}/package.json")).name;
      published = map nameOf typescript.publishedPackages;

      # Every published package is in one fixed group, so a release has one
      # version, which names its assets. The group follows the packages the
      # workspace publishes rather than a list kept by hand. Formatting is
      # left to hk, which formats what Changesets writes as it is committed.
      changesetConfig =
        pkgs.runCommand "ibus-web-changeset-config.json"
          {
            config = builtins.toJSON {
              changelog = "@changesets/cli/changelog";
              commit = false;
              fixed = [ published ];
              linked = [ ];
              access = "public";
              baseBranch = "master";
              updateInternalDependencies = "patch";
              ignore = [ ];
              format = false;
              privatePackages = {
                version = false;
                tag = false;
              };
            };
            passAsFile = [ "config" ];
          }
          ''
            ${pkgs.oxfmt}/bin/oxfmt -c ${../../.oxfmtrc.jsonc} --stdin-filepath config.json < "$configPath" > $out
          '';

      tool = "${typescript.workspaceFor [ "tools/release" ]}/tools/release";
      changeset = "${tool}/node_modules/@changesets/cli/bin.js";
    in
    {
      files.file.".changeset/config.json".source = changesetConfig;

      devshells.default.commands = [
        {
          name = "changeset";
          help = "Changesets' CLI, run at the repository's root";
          command = ''cd "$FLAKE_ROOT" && exec node "$FLAKE_ROOT/tools/release/node_modules/@changesets/cli/bin.js" "$@"'';
        }
      ];

      checks.tools-release = testing.vitestCheck {
        name = "tools-release";
        packageDir = tool;
        env = { };
        inBrowsers = false;
        limit = 60;
      };

      # A minor change to the facade, versioned in a copy of the repository:
      # every published package takes the one new version, nothing private
      # moves, and the notes come from the changelogs written. Changesets
      # reads the changesets' history from git.
      checks.tools-release-changesets =
        pkgs.runCommand "ibus-web-tools-release-changesets"
          {
            nativeBuildInputs = [
              typescript.nodejs
              pkgs.gitMinimal
            ];
          }
          ''
            export HOME=$TMPDIR
            cp -r --no-preserve=mode ${inputs.self} repo
            cd repo
            cp ${changesetConfig} .changeset/config.json
            printf -- '---\n"ibus-web": minor\n---\n\nPreloading.\n' > .changeset/sample.md
            git init -q
            git add -A
            git -c user.name=check -c user.email=check@example.invalid commit -qm sample

            node ${changeset} version

            ${lib.concatMapStrings (dir: ''
              test "$(node -p 'require("./${dir}/package.json").version')" = 0.1.0
            '') typescript.publishedPackages}
            test "$(node -p 'require("./packages/tsconfig/package.json").version')" = 0.0.0
            test ! -e .changeset/sample.md

            node ${tool}/cli.ts 0.1.0 ${lib.escapeShellArgs typescript.publishedPackages} > notes.md
            grep -qx "## ibus-web" notes.md
            grep -q -- ": Preloading.$" notes.md
            cp notes.md $out
          '';
    };
}
