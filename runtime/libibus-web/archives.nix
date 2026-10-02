# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{
  perSystem =
    { pkgs, ... }:
    let
      # tree.tar is uncompressed ustar as engines ship their data, built so
      # that the same tree always gives the same bytes; its version is
      # derived from those bytes, so changing the tree changes it.
      installArchives =
        pkgs.runCommand "ibus-web-install-archives"
          {
            nativeBuildInputs = [
              pkgs.python3
              pkgs.gnutar
              pkgs.jq
            ];
          }
          ''
            python3 ${./tests/archives/make-tree.py} tree $out
            tar --format=ustar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
              --mode=u+rw,go=rX -C tree -cf $out/tree.tar .
            python3 ${./tests/archives/make-tree.py} --corrupt $out
            size=$(find tree -type f -printf '%s\n' | awk '{ sum += $1 } END { print sum }')
            version=$(sha256sum $out/tree.tar | cut -c1-16)
            jq -n --arg version "$version" --argjson size "$size" \
              --rawfile listing $out/listing.txt \
              '{ archive: "tree.tar", version: $version, size: $size, listing: $listing }' \
              > $out/tree.json
          '';
    in
    {
      ibusWeb.runtime.installArchives = installArchives;
    };
}
