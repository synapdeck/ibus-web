# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.engines.table = {
      tables = lib.mkOption {
        type = lib.types.package;
        description = "The table engine's tables, `latex.table` and `xsampa.table`, alone in the output's root.";
      };

      tools = lib.mkOption {
        type = lib.types.package;
        description = ''
          The native table tools: `bin/table-check FILE.table...` exits 1 with
          `path:line: reason` on the first table that fails to parse, and
          `bin/table-describe FILE.table...` prints the tables' engine descriptors
          as one JSON array, each named for its file's stem.
        '';
      };

      sources = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        description = "The C++ files in `engines/table/src` that a build of the engine compiles, by name; the headers beside them are included from there.";
      };
    };
  };
}
