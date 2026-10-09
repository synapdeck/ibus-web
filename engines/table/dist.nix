# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) engines;
      inherit (config.ibusWeb.engines) table;

      # Each engine's descriptor comes from its table's frontmatter. LaTeX,
      # listed first, is the module's default.
      descriptors = pkgs.runCommand "ibus-web-table-engines.json" { } ''
        ${table.tools}/bin/table-describe ${table.tables}/latex.table ${table.tables}/xsampa.table > $out
      '';
    in
    {
      packages.ibus-web-table-dist = engines.mkEngineManifest {
        name = "table";
        package = table.module;

        # table-host peaks at 3,956,736 bytes asserting and 3,952,640 released,
        # both tables loaded; the manifest builder adds headroom after this
        # whole-MiB declaration.
        threads = 0;
        heapBytes = 4 * 1024 * 1024;

        inherit (table.module) settingsSchemaDir;
        engines = descriptors;
        settingsSchemas = [ "org.freedesktop.ibus.panel" ];
      };
    };
}
