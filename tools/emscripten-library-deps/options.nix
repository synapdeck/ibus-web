# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.toolchain.emscriptenTypes = lib.mkOption {
      type = lib.types.attrsOf (
        lib.types.submodule {
          options = {
            link = lib.mkOption {
              type = lib.types.str;
              description = "Where in the repository the types are linked: beside the library, where its type check reads them. hk.pkl's nixInputs must list it.";
            };

            package = lib.mkOption {
              type = lib.types.package;
              description = "The types, from ibusWeb.lib.emscriptenTypes.";
            };
          };
        }
      );
      default = { };
      description = "Types generated for Emscripten JavaScript libraries, by name. Each is a flake package of that name, linked at its link when the dev shell starts and in the tree checks.hk runs over.";
    };
  };
}
