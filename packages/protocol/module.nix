# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb) testing typescript;
    in
    {
      checks.protocol = testing.vitestCheck {
        name = "protocol";
        packageDir = "${typescript.workspace}/packages/protocol";
        limit = 600;
        env = { };
        inBrowsers = false;
      };
    };
}
