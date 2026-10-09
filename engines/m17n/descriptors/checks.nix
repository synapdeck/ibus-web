# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-2.0-or-later
{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb) testing toolchain typescript;
    in
    {
      checks.m17n-descriptors = testing.vitestCheck {
        name = "m17n-descriptors";
        packageDir = "${typescript.workspaceFor [ "engines/m17n/descriptors" ]}/engines/m17n/descriptors";
        env.IBUS_WEB_M17N_DESCRIPTORS = toolchain.pkgsWasm.ibus-engines.m17n.descriptors;
        inBrowsers = false;
        limit = 60;
      };
    };
}
