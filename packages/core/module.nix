# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem = { config, pkgs, ... }: {
    checks.core-browser = config.ibusWeb.testing.vitestCheck {
      name = "core-browser";
      env = {
        # Native text controls need an available font family even in headless Chromium.
        FONTCONFIG_FILE = pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; };
      };
      packageDir = "${config.ibusWeb.typescript.workspace}/packages/core";
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
      packageDir = "${config.ibusWeb.typescript.workspace}/packages/core";
      inBrowsers = false;
      limit = 120;
    };
  };
}
