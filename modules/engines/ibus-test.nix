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
      toolsSource = lib.fileset.toSource {
        root = ../..;
        fileset = lib.fileset.unions [
          ../../tools/package.json
          ../../tools/vitest.config.ts
          ../../tools/tsconfig.json
          ../../tools/ibus-test
          ../../tsconfig.base.json
          ../../tsconfig.node-scripts.json
        ];
      };
      testTools = pkgs.runCommand "ibus-web-ibus-test-tools" { } ''
        cp -R ${toolsSource} $out
        chmod u+w $out/tools
        ln -s ${typescript.packageNodeModules ../../tools} $out/tools/node_modules
      '';
    in
    {
      checks.engines-ibus-test-script = testing.vitestCheck {
        name = "engines-ibus-test-script";
        packageDir = "${testTools}/tools";
        env = { };
        inBrowsers = false;
        limit = 60;
        vitestArgs = [ "ibus-test" ];
      };
    };
}
