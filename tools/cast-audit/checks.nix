# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb) testing typescript;
    in
    {
      checks.engines-cast-audit-script = testing.vitestCheck {
        name = "engines-cast-audit-script";
        packageDir = "${typescript.workspaceFor [ "tools/cast-audit" ]}/tools/cast-audit";
        env = { };
        inBrowsers = false;
        limit = 60;
      };
    };
}
