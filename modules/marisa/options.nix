# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.marisa = lib.mkOption {
      type = lib.types.package;
      description = "MARISA for the build machine, with the patches pkgsWasm.marisa carries, for native tools that read or write the tries a side module does.";
    };
  };
}
