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

        # A test program with all 197 engines open peaks at about 26.5 MB
        # under Node; the declaration leaves several MiB above that, and the
        # manifest builder adds headroom after it.
        threads = 0;
        heapBytes = 32 * 1024 * 1024;

        engines = m17n.descriptors;
      };
    };
}
