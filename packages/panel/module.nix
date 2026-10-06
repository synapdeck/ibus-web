# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, pkgs, ... }:
    let
      workspace = config.ibusWeb.typescript.workspaceFor [ "packages/panel" ];
    in
    {
      checks.panel = config.ibusWeb.testing.vitestCheck {
        name = "panel";
        packageDir = "${workspace}/packages/panel";
        env.FONTCONFIG_FILE = pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; };
        inBrowsers = true;
        limit = 120;
      };
    };
}
