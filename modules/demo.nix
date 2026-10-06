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
      workspace = typescript.workspaceFor [ "examples/hangul" ];
      env = {
        IBUS_WEB_DEMO_RUNTIME = "${config.packages.ibus-runtime}";
        IBUS_WEB_DEMO_HOST = "${workspace}/packages/worker-host/dist";
        IBUS_WEB_DEMO_HANGUL = "${config.packages.ibus-web-hangul-dist}";
      };
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
            cp -R ${workspace} source
            chmod -R u+w source
            cd source/examples/hangul
            node node_modules/vite/bin/vite.js build --outDir "$out" --emptyOutDir
          '';
    in
    {
      packages.demo = demo;
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
              ${lib.concatStringsSep "\n" (
                lib.mapAttrsToList (name: value: "export ${name}=${lib.escapeShellArg value}") env
              )}
              if [ ! -d node_modules ]; then pnpm install --frozen-lockfile; fi
              pnpm --filter demo... --filter '!demo' run build
              pnpm --dir examples/hangul exec vite --host 127.0.0.1 --port 5173 --strictPort "$@"
            '';
          }
        );
      };
      devshells.default.env = lib.mapAttrsToList (name: value: { inherit name value; }) env;
      checks.demo =
        pkgs.runCommand "ibus-web-demo-smoke"
          (
            config.ibusWeb.testing.playwright.env
            // {
              IBUS_WEB_DEMO_PAGE = demo;
              FONTCONFIG_FILE = pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; };
              nativeBuildInputs = [ typescript.nodejs ];
            }
          )
          ''
            ${config.ibusWeb.testing.playwright.setup}
            cp -R ${workspace} source
            chmod -R u+w source
            cd source/examples/hangul
            timeout --kill-after=10 90 node test/smoke.ts > "$out" 2>&1 || { cat "$out"; exit 1; }
            cat "$out"
          '';
    };
}
