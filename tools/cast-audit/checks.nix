# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb) testing typescript;
    in
    {
      checks.tools-cast-audit = testing.vitestCheck {
        name = "tools-cast-audit";
        packageDir = "${typescript.workspaceFor [ "tools/cast-audit" ]}/tools/cast-audit";
        env = { };
        inBrowsers = false;
        limit = 60;
      };
    };
}
