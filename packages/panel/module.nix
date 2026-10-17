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
      workspace = config.ibusWeb.typescript.workspaceFor [ "packages/panel" ];
    in
    {
      ibusWeb.testing.browserChecks.panel-browser = (
        config.ibusWeb.testing.vitestCheck {
          name = "panel-browser";
          packageDir = "${workspace}/packages/panel";
          env.FONTCONFIG_FILE = pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; };
          inBrowsers = true;
          limit = 120;
        }
      );
    };
}
