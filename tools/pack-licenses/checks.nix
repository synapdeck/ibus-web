# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

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

      published = [
        "packages/protocol"
        "packages/worker-host"
        "packages/core"
        "packages/panel"
        "packages/ibus-web"
      ];

      built = typescript.workspaceFor (published ++ [ "tools/pack-licenses" ]);
    in
    {
      # The tool reads these beside whichever package it packs.
      ibusWeb.typescript.extraSources."tools/pack-licenses" = [
        "REUSE.toml"
        "LICENSE-MIT"
        "LICENSE-APACHE"
        "LICENSES"
        "NOTICES"
      ];

      checks.tools-pack-licenses = testing.vitestCheck {
        name = "tools-pack-licenses";
        packageDir = "${typescript.workspaceFor [ "tools/pack-licenses" ]}/tools/pack-licenses";
        env = { };
        inBrowsers = false;
        limit = 120;
      };

      # Every published package's bundle, accounted for as prepack would.
      # Core's key tables must bring their notices.
      checks.tools-pack-licenses-packages =
        pkgs.runCommand "ibus-web-tools-pack-licenses-packages"
          { nativeBuildInputs = [ typescript.nodejs ]; }
          ''
            mkdir $out
            cd ${built}

            for dir in ${lib.escapeShellArgs published}; do
              node tools/pack-licenses/cli.ts check "$dir" > "$out/$(basename "$dir").txt"
            done

            grep -q '^LICENSES/keysymdef-notice.txt ' $out/core.txt
            grep -q '^LICENSES/chromium-notice.txt ' $out/core.txt
          '';

      # `pnpm pack` end to end, in a writable copy so prepack can write into
      # the package: the tarball must carry the licenses, and the package
      # directory must be clean again afterwards.
      checks.tools-pack-licenses-tarball =
        pkgs.runCommand "ibus-web-tools-pack-licenses-tarball"
          {
            nativeBuildInputs = [
              typescript.nodejs
              pkgs.pnpm
            ];
          }
          ''
            export HOME=$TMPDIR
            export npm_config_manage_package_manager_versions=false

            cp -R ${built} work
            chmod -R u+w work
            cd work/packages/worker-host

            mkdir $out
            pnpm pack --pack-destination $out

            tarball=$(echo $out/*.tgz)
            tar -tzf "$tarball" > $out/contents.txt

            for entry in package/LICENSES/effect/LICENSE package/LICENSE-MIT package/LICENSE-APACHE; do
              grep -qx "$entry" $out/contents.txt || { echo "tarball lacks $entry" >&2; exit 1; }
            done

            for leftover in LICENSES .pack-licenses.json; do
              if [ -e "$leftover" ]; then
                echo "$leftover is left in the package directory" >&2
                exit 1
              fi
            done
          '';
    };
}
