# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb) testing typescript;
    in
    {
      checks.tools-engine-manifest = testing.vitestCheck {
        name = "tools-engine-manifest";
        packageDir = "${typescript.workspaceFor [ "tools/engine-manifest" ]}/tools/engine-manifest";
        env = { };
        inBrowsers = false;
        limit = 60;
      };
    };
}
