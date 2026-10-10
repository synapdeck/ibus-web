# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-2.0-or-later
{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) runtime testing typescript;
      dist = config.packages.ibus-web-m17n-dist;
    in
    {
      checks.m17n-host = testing.vitestCheck {
        name = "m17n-host";
        packageDir = "${typescript.workspaceFor [ "packages/worker-host" ]}/packages/worker-host";
        env = {
          IBUS_WEB_WORKER_HOST_TESTS = config.checks.worker-host-node.manifest;
          IBUS_WEB_MODULE_TESTS = pkgs.writeText "ibus-web-m17n-host-tests.json" (
            builtins.toJSON {
              suite = "m17n";
              dists.m17n = "${dist}";
              inherit (dist) heapBytes;
              poolBase = runtime.threadPool.size;

              # The suite declares every instance the metadata lists, as the page does.
              texts.settings = "${dist}/settings.json";
            }
          );
        };
        inBrowsers = false;
        limit = 600;
      };
    };
}
