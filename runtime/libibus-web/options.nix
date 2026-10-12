# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.runtime = {
      libibusWeb = lib.mkOption {
        type = lib.types.package;
        description = "libibus-web for pkgsWasm: the static library the Worker host drives, its header and its pkg-config file.";
      };
    };
  };
}
