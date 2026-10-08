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

      # What the page loads: the runtime, the Worker host and the Hangul engine.
      env = {
        IBUS_WEB_DEMO_RUNTIME = "${config.packages.ibus-runtime}";
        IBUS_WEB_DEMO_HOST = "${workspace}/packages/worker-host/dist";
        IBUS_WEB_DEMO_HANGUL = "${config.packages.ibus-web-hangul-dist}";
      };

      exports =
        vars:
        lib.concatStringsSep "\n" (
          lib.mapAttrsToList (name: value: "export ${name}=${lib.escapeShellArg value}") vars
        );

      # A writable copy of the workspace, entered at the example.
      enterExample = ''
        cp -R ${workspace} source
        chmod -R u+w source
        cd source/examples/hangul
      '';

      demo =
        pkgs.runCommand "ibus-web-demo"
          (
            env
            // {
              nativeBuildInputs = [
                typescript.nodejs
                pkgs.pnpm
              ];
            }
          )
          ''
            ${enterExample}
            node node_modules/vite/bin/vite.js build --outDir "$out" --emptyOutDir
          '';

      # The browsers, offline, a font so text renders headless, and the built page.
      pageEnv = playwright.env // {
        IBUS_WEB_DEMO_PAGE = "${demo}";
        FONTCONFIG_FILE = pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; };
      };

      playwrightTest = "node node_modules/playwright/cli.js test -c test/e2e/playwright.config.ts";

      integration =
        pkgs.runCommand "ibus-web-playwright-integration"
          (
            pageEnv
            // {
              nativeBuildInputs = [ typescript.nodejs ];
              CI = "1";
            }
          )
          ''
            ${playwright.setup}
            ${enterExample}
            mkdir -p "$out"
            export IBUS_WEB_TEST_REPORT=$out/results.json
            export IBUS_WEB_TEST_OUTPUT=$out/artifacts
            set -o pipefail
            timeout --kill-after=10 600 ${playwrightTest} 2>&1 | tee "$out/output.txt"
          '';
    in
    {
      packages.demo = demo;
      packages.playwright-integration = integration;
      ibusWeb.testing.extendedChecks.playwright = integration;

      apps.demo = {
        type = "app";
        program = lib.getExe (
          pkgs.writeShellApplication {
            name = "ibus-web-demo";
            runtimeInputs = [
              typescript.nodejs
              pkgs.pnpm
              pkgs.git
            ];
            text = ''
              root=$(git rev-parse --show-toplevel 2>/dev/null) || {
                echo "Run this app inside the ibus-web checkout." >&2
                exit 1
              }
              cd "$root"
              if [ ! -f flake.nix ] || [ ! -f examples/hangul/package.json ]; then
                echo "Run this app inside the ibus-web checkout." >&2
                exit 1
              fi

              ${exports env}

              if [ ! -d node_modules ]; then pnpm install --frozen-lockfile; fi
              pnpm --filter @ibus-web/example-hangul... --filter '!@ibus-web/example-hangul' run build
              pnpm --dir examples/hangul exec vite --host 127.0.0.1 --port 5173 --strictPort "$@"
            '';
          }
        );
      };

      apps.keystroke-bench = {
        type = "app";
        program = lib.getExe (
          pkgs.writeShellApplication {
            name = "ibus-web-keystroke-bench";
            runtimeInputs = [ typescript.nodejs ];
            text = ''
              ${exports pageEnv}

              run_dir=$(mktemp -d)
              trap 'rm -rf "$run_dir"' EXIT
              cd "$run_dir"
              ${enterExample}

              export IBUS_WEB_KEYSTROKE_BENCH=1
              ${playwrightTest} "$@"
            '';
          }
        );
      };

      devshells.default.env = lib.mapAttrsToList (name: value: { inherit name value; }) env;

      checks.demo =
        pkgs.runCommand "ibus-web-demo-smoke"
          (
            pageEnv
            // {
              nativeBuildInputs = [ typescript.nodejs ];
            }
          )
          ''
            ${playwright.setup}
            ${enterExample}
            timeout --kill-after=10 90 node test/smoke.ts > "$out" 2>&1 || { cat "$out"; exit 1; }
            cat "$out"
          '';
    };
}
