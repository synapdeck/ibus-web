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
      inherit (config.ibusWeb) typescript;
      inherit (config.ibusWeb.testing) playwright;
      workspace = typescript.workspaceFor [ "examples/hangul" ];
      suites = lib.fileset.toSource {
        root = ../tests/playwright;
        fileset = lib.fileset.fileFilter (file: file.hasExt "ts" || file.hasExt "json") ../tests/playwright;
      };
      env = playwright.env // {
        IBUS_WEB_DEMO_PAGE = "${config.packages.demo}";
        FONTCONFIG_FILE = pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; };
      };
      prepare = ''
        cp -R ${workspace} source
        chmod -R u+w source
        mkdir -p source/tests
        cp -R ${suites} source/tests/playwright
        chmod -R u+w source/tests/playwright
        cd source
      '';
      integration =
        pkgs.runCommand "ibus-web-playwright-integration"
          (
            env
            // {
              nativeBuildInputs = [ typescript.nodejs ];
              CI = "1";
            }
          )
          ''
            ${playwright.setup}
            ${prepare}
            mkdir -p "$out"
            export IBUS_WEB_TEST_REPORT=$out/results.json
            export IBUS_WEB_TEST_OUTPUT=$out/artifacts
            set -o pipefail
            timeout --kill-after=10 600 node node_modules/playwright/cli.js test \
              -c tests/playwright/playwright.config.ts 2>&1 | tee "$out/output.txt"
          '';
    in
    {
      packages.playwright-integration = integration;
      ibusWeb.testing.extendedChecks.playwright = integration;
      checks.bundle-scan =
        pkgs.runCommand "ibus-web-bundle-scan"
          {
            nativeBuildInputs = [ typescript.nodejs ];
            IBUS_WEB_DEMO_PAGE = "${config.packages.demo}";
          }
          ''
            ${prepare}
            mkdir -p "$out"
            set -o pipefail
            node tools/bundle-scan/node_modules/vitest/vitest.mjs run --root tools/bundle-scan --configLoader native scan.test.ts 2>&1 | tee "$out/tests.txt"
            export IBUS_WEB_SCAN_OUTPUT=$out
            node tools/bundle-scan/scan.ts 2>&1 | tee "$out/scan.txt"
            cp ${config.packages.demo}/page-bundle-graph.json "$out/demo-graph.json"
          '';
      apps.keystroke-bench = {
        type = "app";
        program = lib.getExe (
          pkgs.writeShellApplication {
            name = "ibus-web-keystroke-bench";
            runtimeInputs = [ typescript.nodejs ];
            text = ''
              ${lib.concatStringsSep "\n" (
                lib.mapAttrsToList (name: value: "export ${name}=${lib.escapeShellArg value}") env
              )}
              run_dir=$(mktemp -d)
              trap 'rm -rf "$run_dir"' EXIT
              cd "$run_dir"
              ${prepare}
              export IBUS_WEB_KEYSTROKE_BENCH=1
              node node_modules/playwright/cli.js test -c tests/playwright/playwright.config.ts "$@"
            '';
          }
        );
      };
    };
}
