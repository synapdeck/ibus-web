# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb)
        engines
        runtime
        testing
        typescript
        ;
      inherit (config.ibusWeb.engines) table;
      dist = config.packages.ibus-web-table-dist;

      # The shipped X-SAMPA table beside a LaTeX table that doesn't parse.
      brokenTables = pkgs.runCommand "ibus-web-table-broken-tables" { } ''
        mkdir $out
        cp ${table.tables}/xsampa.table $out/
        cp ${./broken.table} $out/latex.table
      '';

      brokenModule = table.module.override { tables = brokenTables; };

      brokenDist = engines.mkEngineManifest {
        name = "table";
        package = brokenModule;
        threads = 0;
        inherit (dist) heapBytes;
        inherit (brokenModule) settingsSchemaDir;
        engines =
          pkgs.runCommand "ibus-web-table-broken-engines.json" { nativeBuildInputs = [ pkgs.jq ]; }
            ''
              jq .engines ${dist}/manifest.json > $out
            '';
        settingsSchemas = [ "org.freedesktop.ibus.panel" ];
      };

      # What the native parser prints to stderr for the broken table, at the
      # path the side module reads it from.
      brokenMessage = pkgs.runCommand "ibus-web-table-broken-message" { } ''
        if ${table.tools}/bin/table-check ${brokenTables}/latex.table 2> output; then
          echo "the broken table parsed" >&2
          exit 1
        fi
        head -n 1 output | tr -d '\n' > $out
      '';
    in
    {
      checks.table-host = testing.vitestCheck {
        name = "table-host";
        packageDir = "${typescript.workspaceFor [ "packages/worker-host" ]}/packages/worker-host";
        env = {
          IBUS_WEB_WORKER_HOST_TESTS = config.checks.worker-host-node.manifest;
          IBUS_WEB_MODULE_TESTS = pkgs.writeText "ibus-web-table-host-tests.json" (
            builtins.toJSON {
              suite = "table";
              dists = {
                table = "${dist}";
                broken = "${brokenDist}";
              };
              inherit (dist) heapBytes;
              poolBase = runtime.threadPool.size;
              texts.brokenMessage = "${brokenMessage}";
            }
          );
        };
        inBrowsers = false;
        limit = 600;
      };
    };
}
