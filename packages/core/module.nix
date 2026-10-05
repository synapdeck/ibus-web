# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, pkgs, ... }:
    let
      workspace = config.ibusWeb.typescript.workspaceFor [
        "packages/core"
        "packages/test-programs"
      ];
    in
    {
      checks.core-browser = config.ibusWeb.testing.vitestCheck {
        name = "core-browser";
        env = {
          # Native text controls need an available font family even in headless Chromium.
          FONTCONFIG_FILE = pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; };
          IBUS_WEB_WORKER_HOST_TESTS = config.checks.worker-host-node.manifest;
          IBUS_WEB_HANGUL_MANIFEST = "${config.packages.ibus-web-hangul-dist}/manifest.json";
        };
        packageDir = "${workspace}/packages/core";
        inBrowsers = true;
        limit = 120;
        vitestArgs = [
          "--config"
          "vitest.browser.config.ts"
        ];
      };
      checks.core = config.ibusWeb.testing.vitestCheck {
        name = "core";
        env = { };
        packageDir = "${workspace}/packages/core";
        inBrowsers = false;
        limit = 120;
      };
    };
}
