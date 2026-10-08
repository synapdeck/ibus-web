# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb) testing typescript;
    in
    {
      checks.tools-latex-table = testing.vitestCheck {
        name = "tools-latex-table";
        packageDir = "${typescript.workspaceFor [ "tools/latex-table" ]}/tools/latex-table";
        env = { };
        inBrowsers = false;
        limit = 60;
      };
    };
}
