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

        # rime-host peaks at 124,395,520 bytes asserting and 124,329,984
        # released, with rime_ice and luna_pinyin open in one Worker, whose
        # tables Rime maps into memory. A page-size change's redeployment
        # sets the peak, which varies from run to run (96 to 124 MB) with how
        # the deployer's work overlaps the open session's. The workload runs
        # one engine thread at a time, the deployer's; LevelDB's compaction
        # thread stays once started, so a deployment after it needs a second.
        # The declaration leaves several MiB above the break, and the
        # manifest builder adds headroom after it.
        threads = 2;
        heapBytes = 123 * 1024 * 1024;
      };
    };
}
