# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb) testing typescript;
    in
    {
      checks.libibus-web-vendored-script = testing.vitestCheck {
        name = "libibus-web-vendored-script";
        packageDir = "${typescript.workspaceFor [ "tools/vendor-inventory" ]}/tools/vendor-inventory";
        env = { };
        inBrowsers = false;
        limit = 60;
      };
    };
}
