# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

# The archives the host's tests install, built as engines' archives are:
# pax, with archiveTarFlags, each entry named from the store's root under a
# store path.
#
# tree.tar holds a tree of nested directories and files spanning several
# storage chunks under dataName, and tree-upgrade.tar the next version's
# tree; tree.json describes each, its version (from its bytes), its unpacked
# size in bytes and its listing, one `PATH<TAB>d` or `PATH<TAB>f SIZE
# SHA256` line per entry relative to the store path, sorted bytewise, with
# tree-upgrade.tar's under `upgrade`. tree.tar.br is tree.tar compressed,
# truncated.tar.br the same cut short, and corrupt.tar.br no Brotli at all.
#
# The installer's own tests take the rest, which fixtures.json names:
# long.tar, under longName, has a name and a link target too long for
# ustar, and is built twice, from the tree as written and with its times
# changed, which must give the same bytes; refused/ holds archives under
# refusedName of a file the installer accepts, then one member it must
# refuse; symlink.tar a link to "/", which it accepts; and corrupt.tar is
# tree.tar with a header's checksum broken.
{
  runCommand,
  python3,
  gnutar,
  jq,
  brotli,
  archiveTarFlags,
  dataName,
  longName,
  refusedName,
}:
runCommand "ibus-web-worker-host-archives"
  {
    nativeBuildInputs = [
      python3
      gnutar
      jq
      brotli
    ];
  }
  ''
    mkdir $out

    # Archives the tree $1 as the store path $2, into $out/$3.
    pack() {
      rm -rf store
      mkdir store
      cp -a "$1" "store/$2"
      tar ${archiveTarFlags} --mode=u+rw,go=rX -C store -cf "$out/$3" "$2"
      rm -rf store
    }

    # Describes the archive $1 of the tree $2, whose listing is $3, as JSON.
    describe() {
      local archive=$1 tree=$2 listing=$3 size version
      size=$(find "$tree" -type f -printf '%s\n' | awk '{ sum += $1 } END { print sum + 0 }')
      version=$(sha256sum "$out/$archive" | cut -c1-16)
      jq -n --arg archive "$archive" --arg version "$version" --argjson size "$size" \
        --rawfile listing "$out/$listing" \
        '{ $archive, $version, $size, $listing }'
    }

    python3 ${./test/archives/make-tree.py} tree $out
    python3 ${./test/archives/make-tree.py} --upgrade tree-upgrade $out
    pack tree ${dataName} tree.tar
    pack tree-upgrade ${dataName} tree-upgrade.tar
    describe tree.tar tree listing.txt > tree.json
    describe tree-upgrade.tar tree-upgrade listing-upgrade.txt > upgrade.json
    jq --slurpfile upgrade upgrade.json '. + { upgrade: $upgrade[0] }' tree.json > $out/tree.json

    python3 ${./test/archives/make-tree.py} --refused ${refusedName} $out
    python3 ${./test/archives/make-tree.py} --corrupt $out

    name="data/$(printf 'n%.0s' $(seq 120)).txt"
    target="/nix/store/00000000000000000000000000000000-$(printf 't%.0s' $(seq 70))/share/data"
    mkdir -p long/data
    printf 'long\n' > "long/$name"
    ln -s "$target" long/data/link
    pack long ${longName} long.tar
    touch -d @1000000000 "long/$name" long/data
    touch -h -d @1000000000 long/data/link
    mv $out/long.tar first.tar
    pack long ${longName} long.tar
    cmp first.tar $out/long.tar

    jq -n --arg data ${dataName} --arg refused ${refusedName} --arg longName ${longName} \
      --arg name "$name" --arg target "$target" \
      '{ $data, $refused, long: { storeName: $longName, $name, $target } }' > $out/fixtures.json

    brotli --quality=11 --output=$out/tree.tar.br $out/tree.tar
    head -c -1 $out/tree.tar.br > $out/truncated.tar.br
    printf '\377\377\377\377' > $out/corrupt.tar.br
  ''
