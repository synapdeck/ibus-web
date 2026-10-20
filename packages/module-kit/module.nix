# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, ... }:
    let
      workspace = config.ibusWeb.typescript.workspaceFor [ "packages/module-kit" ];
    in
    {
      checks.module-kit-node = config.ibusWeb.testing.vitestCheck {
        name = "module-kit-node";
        env = { };
        packageDir = "${workspace}/packages/module-kit";
        inBrowsers = false;
        limit = 120;
      };
    };
}
