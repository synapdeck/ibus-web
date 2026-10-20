# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

# The fixture module built with the plugin in every bundler it supports. A
# check of its own, so that a change to the kit alone doesn't install and run
# six bundlers.
{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb) testing typescript;
    in
    {
      checks.module-kit-bundlers = testing.vitestCheck {
        name = "module-kit-bundlers";
        packageDir = "${
          typescript.workspaceFor [ "packages/module-kit/checks/bundlers" ]
        }/packages/module-kit/checks/bundlers";
        env = { };
        inBrowsers = false;
        limit = 300;
      };
    };
}
