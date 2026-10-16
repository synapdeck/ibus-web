# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

# Files the repository must track but Nix generates: `nix run .#write-files`
# writes them, and a check per file fails while a tracked copy differs.
{ inputs, lib, ... }:
{
  imports = [ "${inputs.files}/flake-module.nix" ];

  perSystem =
    { config, pkgs, ... }:
    let
      # The paths the writer manages, tracked so that a later run can tell
      # which of them the Nix has stopped configuring. Being generated, its
      # own check fails when the Nix changes and the writer hasn't run.
      manifestPath = ".generated-files";
      managed = lib.sort lib.lessThan (lib.remove manifestPath (lib.attrNames config.files.file));
      manifest = pkgs.writeText "ibus-web-generated-files" ''
        # SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
        # SPDX-License-Identifier: MIT OR Apache-2.0
        #
        # Written by `nix run .#write-files`: the files it manages, which it
        # deletes once the Nix no longer configures them.
        ${lib.concatLines managed}'';

      # The files module only writes; this deletes first what the tracked
      # manifest lists and the new one doesn't. A path that could leave the
      # checkout is never deleted, whatever the manifest says.
      writeFiles = pkgs.writeShellApplication {
        name = "write-files";
        runtimeInputs = [
          pkgs.gitMinimal
          pkgs.gnugrep
        ];
        text = ''
          cd "$(git rev-parse --show-toplevel)"

          if [ -f ${manifestPath} ]; then
            while IFS= read -r path; do
              case "$path" in
              "" | "#"* | /* | *..*) continue ;;
              esac
              if ! grep -qxF -- "$path" ${manifest}; then
                rm -f -- "$path"
              fi
            done < ${manifestPath}
          fi

          exec ${lib.getExe config.files.writer.drv}
        '';
      };
    in
    {
      files.file.${manifestPath}.source = manifest;

      apps.write-files = {
        type = "app";
        program = lib.getExe writeFiles;
        meta.description = "Write every generated file, deleting those no longer generated";
      };

      devshells.default.packages = [ writeFiles ];

      # A scratch repository whose manifest lists a file the Nix doesn't
      # configure, beside one nothing manages.
      checks.flake-write-files =
        pkgs.runCommand "ibus-web-flake-write-files"
          {
            nativeBuildInputs = [
              pkgs.gitMinimal
              writeFiles
            ];
          }
          ''
            export HOME=$TMPDIR
            mkdir repo
            cd repo
            git init -q

            mkdir -p .github/workflows
            printf '%s\n' '# a comment' .github/workflows/removed.yml ../outside > ${manifestPath}
            echo stale > .github/workflows/removed.yml
            echo unmanaged > .github/workflows/unmanaged.yml
            echo outside > ../outside

            write-files

            test ! -e .github/workflows/removed.yml
            test "$(cat .github/workflows/unmanaged.yml)" = unmanaged
            test "$(cat ../outside)" = outside
            cmp ${manifestPath} ${manifest}
            ${lib.concatMapStrings (path: ''
              cmp ${lib.escapeShellArg path} ${config.files.file.${path}.source}
            '') managed}
            touch $out
          '';
    };
}
