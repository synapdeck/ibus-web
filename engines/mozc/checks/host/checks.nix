# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: BSD-3-Clause
{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) runtime testing typescript;
      dist = config.packages.ibus-web-mozc-dist;
    in
    {
      checks.mozc-host = testing.vitestCheck {
        name = "mozc-host";
        packageDir = "${typescript.workspaceFor [ "packages/worker-host" ]}/packages/worker-host";
        env = {
          IBUS_WEB_WORKER_HOST_TESTS = config.checks.worker-host-node.manifest;
          IBUS_WEB_MODULE_TESTS = pkgs.writeText "ibus-web-mozc-host-tests.json" (
            builtins.toJSON {
              suite = "mozc";
              dists.mozc = "${dist}";
              inherit (dist) heapBytes;
              poolBase = runtime.threadPool.size;
              texts = { };
            }
          );
        };
        inBrowsers = false;
        limit = 600;
      };
    };
}
