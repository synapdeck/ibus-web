# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem = { config, ... }: {
    checks.core = config.ibusWeb.testing.vitestCheck {
      name = "core";
      env = { };
      packageDir = "${config.ibusWeb.typescript.workspace}/packages/core";
      inBrowsers = false;
      limit = 120;
    };
  };
}
