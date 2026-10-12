# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-3.0-or-later
{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) engines;
      package = config.packages.ibus-web-rime;
      inherit (package) descriptors;

      # Each engine's dictionaries are data of its own, installed when it is
      # first made.
      enginesWithData =
        pkgs.runCommand "ibus-web-rime-engines.json" { nativeBuildInputs = [ pkgs.jq ]; }
          ''
            jq --slurpfile data ${descriptors}/engine-data.json 'map(. + { data: $data[0][.name] })' \
              ${descriptors}/engines.json > $out
          '';
    in
    {
      packages.ibus-web-rime-dist = engines.mkEngineManifest {
        name = "rime";
        inherit package;
        inherit (package) settingsSchemaDir;
        engines = enginesWithData;
        settingsSchemas = "${descriptors}/settings-schemas.json";
        settingsPaths = "${descriptors}/settings-paths.json";

        # A first bound, generous enough for rime-host to run and measure what
        # the module needs.
        threads = 2;
        heapBytes = 256 * 1024 * 1024;
      };
    };
}
