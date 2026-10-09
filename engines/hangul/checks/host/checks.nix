# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-2.0-or-later
{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) testing typescript runtime;
      dist = config.packages.ibus-web-hangul-dist;
    in
    {
      checks.hangul-host = testing.vitestCheck {
        name = "hangul-host";
        packageDir = "${typescript.workspaceFor [ "packages/worker-host" ]}/packages/worker-host";
        env = {
          IBUS_WEB_WORKER_HOST_TESTS = config.checks.worker-host-node.manifest;
          IBUS_WEB_MODULE_TESTS = pkgs.writeText "ibus-web-hangul-host-tests.json" (
            builtins.toJSON {
              suite = "hangul";
              dists.hangul = "${dist}";
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
