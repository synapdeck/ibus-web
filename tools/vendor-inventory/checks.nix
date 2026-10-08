# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb) testing typescript;
    in
    {
      checks.tools-vendor-inventory = testing.vitestCheck {
        name = "tools-vendor-inventory";
        packageDir = "${typescript.workspaceFor [ "tools/vendor-inventory" ]}/tools/vendor-inventory";
        env = { };
        inBrowsers = false;
        limit = 60;
      };
    };
}
