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

      installArchives = lib.mkOption {
        type = lib.types.package;
        description = "Archives for testing engine data installs: tree.tar, a deterministic ustar of nested directories and files spanning several storage chunks, and tree-upgrade.tar, the next version's tree built the same way; listing.txt and listing-upgrade.txt, their listings, one `PATH<TAB>d` or `PATH<TAB>f SIZE SHA256` line per entry, sorted bytewise; tree.json, tree.tar's version (from its bytes), its unpacked size in bytes and its listing, with the same for tree-upgrade.tar under `upgrade`; and archives the installer must refuse: absolute.tar, dotdot.tar, symlink.tar, hardlink.tar, fifo.tar (each a valid file, then the refused member) and corrupt.tar (tree.tar with a header's checksum broken).";
      };
    };
  };
}
