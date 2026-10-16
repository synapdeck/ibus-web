# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.release.engines = lib.mkOption {
      description = "The engines a release ships, by module name, each with what its source bundle is made from.";
      default = { };
      type = lib.types.attrsOf (
        lib.types.submodule {
          options = {
            dist = lib.mkOption {
              type = lib.types.package;
              description = "The engine's distribution, as mkEngineManifest builds it.";
            };

            module = lib.mkOption {
              type = lib.types.package;
              description = "The engine's side module; its sources and those of every library it links are in the bundle.";
            };

            extraSources = lib.mkOption {
              type = lib.types.listOf lib.types.package;
              default = [ ];
              description = ''
                What else the engine is built from: the upstream packages its data comes from,
                and libraries or dependencies its build takes other than as build inputs. The
                bundle carries a fixed-output derivation, such as a fetched file, as it is, and
                any other's src.
              '';
            };
          };
        }
      );
    };
  };
}
