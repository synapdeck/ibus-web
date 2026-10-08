# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb) testing typescript;
    in
    {
      checks.tools-pack-licenses = testing.vitestCheck {
        name = "tools-pack-licenses";
        packageDir = "${typescript.workspaceFor [ "tools/pack-licenses" ]}/tools/pack-licenses";
        env = { };
        inBrowsers = false;
        limit = 120;
      };
    };
}
