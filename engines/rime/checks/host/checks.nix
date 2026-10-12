# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-3.0-or-later
{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) runtime testing typescript;
      dist = config.packages.ibus-web-rime-dist;
    in
    {
      checks.rime-host = testing.vitestCheck {
        name = "rime-host";
        packageDir = "${typescript.workspaceFor [ "packages/worker-host" ]}/packages/worker-host";
        env = {
          IBUS_WEB_WORKER_HOST_TESTS = config.checks.worker-host-node.manifest;
          IBUS_WEB_MODULE_TESTS = pkgs.writeText "ibus-web-rime-host-tests.json" (
            builtins.toJSON {
              suite = "rime";
              dists.rime = "${dist}";
              inherit (dist) heapBytes;
              poolBase = runtime.threadPool.size;

              # The suite declares every instance the metadata lists, as the page does.
              texts.settings = "${dist}/settings.json";
            }
          );
        };
        inBrowsers = false;
        limit = 1200;
      };
    };
}
