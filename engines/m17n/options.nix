# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-2.0-or-later

{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.engines.m17n = lib.mkOption {
      description = "The m17n side module and what its distribution is made from.";
      type = lib.types.submodule {
        options = {
          package = lib.mkOption {
            type = lib.types.package;
            description = "ibus-engines.m17n: m17n.wasm, with default.xml in its data output.";
          };

          descriptors = lib.mkOption {
            type = lib.types.path;
            description = "A JSON file of the module's engine descriptors, the default first.";
          };

          settingsPaths = lib.mkOption {
            type = lib.types.path;
            description = "A JSON file of each engine's path for org.freedesktop.ibus.engine.m17n, as settingsPaths takes it.";
          };

          settingsPatterns = lib.mkOption {
            type = lib.types.attrsOf lib.types.str;
            description = "Each relocatable schema's pattern for its paths, as settingsPatterns takes it.";
          };

          settingsSchemaDir = lib.mkOption {
            type = lib.types.str;
            description = "The compiled schema directory m17n.wasm keeps in its closure.";
          };

          settingsSchemas = lib.mkOption {
            type = lib.types.path;
            description = "A JSON file listing the module's schema ids: ibus-m17n's, the panel's and every variable schema's.";
          };

          defaultEngine = lib.mkOption {
            type = lib.types.str;
            default = "m17n:t:latn-post";
            description = "The engine the descriptors list first, the module's default.";
          };
        };
      };
    };
  };
}
