# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb) testing typescript;
    in
    {
      # The conformance suite skips itself here: it runs from ibusTest, with a
      # native session and a module to compare.
      checks.tools-ibus-test = testing.vitestCheck {
        name = "tools-ibus-test";
        packageDir = "${typescript.workspaceFor [ "tools/ibus-test" ]}/tools/ibus-test";
        env = { };
        inBrowsers = false;
        limit = 60;
      };
    };
}
