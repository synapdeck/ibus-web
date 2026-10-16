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
          settingsPatterns
          ;

        # m17n-host's heap peaks at 25,180,288 bytes asserting and 25,178,368
        # released with every engine open in one Worker; the declaration
        # leaves several MiB above that, and the manifest builder adds
        # headroom after it.
        threads = 0;
        heapBytes = 29 * 1024 * 1024;

        engines = m17n.descriptors;
      };

      ibusWeb.demo.modules.m17n = config.packages.ibus-web-m17n-dist;
    };
}
