# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{
  perSystem =
    { pkgs, ... }:
    let
      # tree.tar is uncompressed ustar as engines ship their data, built so
      # that the same tree always gives the same bytes; its version is
      # derived from those bytes, so changing the tree changes it.
      # tree-upgrade.tar is the next version's, built the same way. tree.json
      # describes tree.tar and, under `upgrade`, tree-upgrade.tar; the rest
      # are archives the installer must refuse.
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
            # Describes an archive built from a tree, as JSON.
            describe() {
              local tree=$1 archive=$2 listing=$3 size version
              tar --format=ustar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
                --mode=u+rw,go=rX -C "$tree" -cf "$out/$archive" .
              size=$(find "$tree" -type f -printf '%s\n' | awk '{ sum += $1 } END { print sum + 0 }')
              version=$(sha256sum "$out/$archive" | cut -c1-16)
              jq -n --arg archive "$archive" --arg version "$version" --argjson size "$size" \
                --rawfile listing "$out/$listing" \
                '{ $archive, $version, $size, $listing }'
            }

            python3 ${./tests/archives/make-tree.py} tree $out
            python3 ${./tests/archives/make-tree.py} --upgrade tree-upgrade $out
            describe tree tree.tar listing.txt > tree.json
            describe tree-upgrade tree-upgrade.tar listing-upgrade.txt > upgrade.json
            python3 ${./tests/archives/make-tree.py} --corrupt $out
            jq --slurpfile upgrade upgrade.json '. + { upgrade: $upgrade[0] }' tree.json > $out/tree.json
          '';
    in
    {
      ibusWeb.runtime.installArchives = installArchives;
    };
}
