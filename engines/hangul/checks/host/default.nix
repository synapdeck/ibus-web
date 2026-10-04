# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-2.0-or-later
{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb) testing typescript runtime;
      dist = config.packages.ibus-web-hangul-dist;
    in
    {
      checks.hangul-host = testing.vitestCheck {
        name = "hangul-host";
        packageDir = "${typescript.workspace}/packages/worker-host";
        env = {
          IBUS_WEB_WORKER_HOST_TESTS = config.checks.worker-host-node.manifest;
          IBUS_WEB_HANGUL_MANIFEST = "${dist}/manifest.json";
          IBUS_WEB_HANGUL_HEAP_BYTES = toString dist.heapBytes;
          IBUS_WEB_HANGUL_POOL_BASE = toString runtime.threadPool.size;
        };
        inBrowsers = false;
        limit = 600;
      };
    };
}
