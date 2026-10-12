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
      inherit (config.ibusWeb) demo typescript;
      inherit (config.ibusWeb.testing) playwright;

      workspace = typescript.workspaceFor [ "examples/demo" ];

      # Each module's distribution under its name, beside the map from module name
      # to manifest that the page reads to find them.
      modules = pkgs.linkFarm "ibus-web-demo-modules" (
        lib.mapAttrsToList (name: path: { inherit name path; }) demo.modules
        ++ [
          {
            name = "modules.json";
            path = pkgs.writeText "ibus-web-demo-modules.json" (
              builtins.toJSON (lib.mapAttrs (name: _: "./${name}/manifest.json") demo.modules)
            );
          }
        ]
      );

      # What the page loads: the runtime, the Worker host and every module.
      env = {
        IBUS_WEB_DEMO_RUNTIME = "${config.packages.ibus-runtime}";
        IBUS_WEB_DEMO_HOST = "${workspace}/packages/worker-host/dist";
        IBUS_WEB_DEMO_MODULES = "${modules}";
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
        cd source/examples/demo
      '';

      page =
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
        IBUS_WEB_DEMO_PAGE = "${page}";
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
            # Each of Rime's tests installs tens of MB of dictionaries in a fresh browser context.
            timeout --kill-after=10 1800 ${playwrightTest} 2>&1 | tee "$out/output.txt"
          '';
    in
    {
      packages.demo = page;
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
              if [ ! -f flake.nix ] || [ ! -f examples/demo/package.json ]; then
                echo "Run this app inside the ibus-web checkout." >&2
                exit 1
              fi

              ${exports env}

              if [ ! -d node_modules ]; then pnpm install --frozen-lockfile; fi
              pnpm --filter @ibus-web/example-demo... --filter '!@ibus-web/example-demo' run build
              pnpm --dir examples/demo exec vite --host 127.0.0.1 --port 5173 --strictPort "$@"
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

      checks.example-demo-smoke =
        pkgs.runCommand "ibus-web-example-demo-smoke"
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
