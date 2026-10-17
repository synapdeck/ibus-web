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
      workspace = config.ibusWeb.typescript.workspaceFor [ "packages/ibus-web" ];
    in
    {
      ibusWeb.testing.browserChecks.ibus-web-browser = (
        config.ibusWeb.testing.vitestCheck {
          name = "ibus-web-browser";
          packageDir = "${workspace}/packages/ibus-web";
          env.FONTCONFIG_FILE = pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; };
          inBrowsers = true;
          limit = 120;
        }
      );
    };
}
