# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-2.0-or-later
{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb) engines;
      inherit (config.ibusWeb.engines) m17n;
    in
    {
      packages.ibus-web-m17n-dist = engines.mkEngineManifest {
        name = "m17n";
        inherit (m17n)
          package
          settingsSchemaDir
          settingsSchemas
          settingsPaths
          ;

        # m17n-host peaks at 27,656,192 bytes asserting and 27,648,000
        # released with every engine open in one Worker; the declaration
        # leaves several MiB above that, and the manifest builder adds
        # headroom after it.
        threads = 0;
        heapBytes = 31 * 1024 * 1024;

        engines = m17n.descriptors;
      };

      ibusWeb.demo.modules.m17n = config.packages.ibus-web-m17n-dist;
    };
}
