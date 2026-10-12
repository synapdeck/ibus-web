# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-3.0-or-later
{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb) testing toolchain typescript;
      data = toolchain.pkgsWasm.ibus-web-rime-data;
      fewer = data.override {
        schemas = [
          "rime_ice"
          "luna_pinyin"
          "jyut6ping3"
        ];
      };
    in
    {
      checks.rime-descriptors = testing.vitestCheck {
        name = "rime-descriptors";
        packageDir = "${typescript.workspaceFor [ "engines/rime/descriptors" ]}/engines/rime/descriptors";
        env = {
          IBUS_WEB_RIME_DESCRIPTORS = data.descriptors;
          IBUS_WEB_RIME_DESCRIPTORS_FEWER = fewer.descriptors;
        };
        inBrowsers = false;
        limit = 60;
      };
    };
}
