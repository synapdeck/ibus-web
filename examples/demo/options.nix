# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.demo.modules = lib.mkOption {
      type = lib.types.attrsOf lib.types.package;
      default = { };
      description = ''
        The module distributions the demo serves, by module name. The page lists every engine of
        each, and selects the first module's default engine when it opens.
      '';
    };
  };
}
