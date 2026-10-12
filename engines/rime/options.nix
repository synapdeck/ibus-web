# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-3.0-or-later

{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.engines.rime = lib.mkOption {
      description = "The Rime side module and what its distribution is made from.";
      type = lib.types.submodule {
        options = {
          package = lib.mkOption {
            type = lib.types.package;
            description = "ibus-web-rime: rime.wasm, with the common data, the dictionaries and the descriptors in its passthru.";
          };

          descriptors = lib.mkOption {
            type = lib.types.path;
            description = "A JSON file of the module's engine descriptors, rime:rime_ice first.";
          };

          engineData = lib.mkOption {
            type = lib.types.path;
            description = "A JSON file of each engine's dictionary store paths, by engine name.";
          };

          settingsPaths = lib.mkOption {
            type = lib.types.path;
            description = "A JSON file of each engine's path for org.freedesktop.ibus.engine.rime.schema, as settingsPaths takes it.";
          };

          settingsSchemaDir = lib.mkOption {
            type = lib.types.str;
            description = "The compiled schema directory rime.wasm keeps in its closure.";
          };

          settingsSchemas = lib.mkOption {
            type = lib.types.path;
            description = "A JSON file listing the module's schema ids: Rime's fixed and relocatable schemas and the panel's.";
          };
        };
      };
    };
  };
}
