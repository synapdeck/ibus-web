# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) typescript;

      workspace = typescript.workspaceFor [ "tools/bundle-scan" ];
    in
    {
      # The scanner's own tests, then its scan of the demo's production page.
      checks.tools-bundle-scan =
        pkgs.runCommand "ibus-web-tools-bundle-scan"
          {
            nativeBuildInputs = [ typescript.nodejs ];
            IBUS_WEB_DEMO_PAGE = "${config.packages.demo}";
          }
          ''
            cp -R ${workspace} source
            chmod -R u+w source
            cd source/tools/bundle-scan

            mkdir -p "$out"
            set -o pipefail
            node node_modules/vitest/vitest.mjs run --configLoader native 2>&1 | tee "$out/tests.txt"

            export IBUS_WEB_SCAN_OUTPUT=$out
            node scan.ts 2>&1 | tee "$out/scan.txt"
            cp ${config.packages.demo}/page-bundle-graph.json "$out/demo-graph.json"
          '';
    };
}
