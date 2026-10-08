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
    };
}
