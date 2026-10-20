# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, ... }:
    let
      workspace = config.ibusWeb.typescript.workspaceFor [ "examples/pinyin-tones" ];
    in
    {
      checks.example-pinyin-tones-node = config.ibusWeb.testing.vitestCheck {
        name = "example-pinyin-tones-node";
        env = { };
        packageDir = "${workspace}/examples/pinyin-tones";
        inBrowsers = false;
        limit = 120;
      };
    };
}
