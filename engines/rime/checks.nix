# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-3.0-or-later
{
  perSystem =
    { config, pkgs, ... }:
    let
      # Two schemas with small dictionaries, one depending on the other's,
      # keep the extra deployment and compression cheap.
      schemas = [
        "luna_pinyin"
        "cangjie5"
      ];
      fewer = config.packages.ibus-web-rime-dist.override { inherit schemas; };
      fewerNpm = config.ibusWeb.typescript.npmPackages.engine-rime.override { inherit schemas; };
    in
    {
      checks.rime-dist-schemas =
        pkgs.runCommand "ibus-web-rime-dist-schemas"
          {
            nativeBuildInputs = [
              pkgs.jq
              pkgs.gnutar
              pkgs.gzip
            ];
          }
          ''
            jq -e '[.engines[].name] | sort == ["rime:cangjie5", "rime:luna_pinyin"]' ${fewer}/manifest.json > /dev/null \
              || { echo "the build with two schemas has other engines" >&2; exit 1; }

            jq -e '[.data[].storePath] as $paths | all(.engines[]; (.data | length) > 0 and all(.data[]; IN($paths[])))' \
              ${fewer}/manifest.json > /dev/null \
              || { echo "an engine names no data, or data the manifest lacks" >&2; exit 1; }

            # Dependencies deploy though not listed: luna_pinyin's reverse lookup
            # needs stroke, and cangjie5's needs luna_pinyin's dictionary.
            has() {
              jq -e --arg engine "$1" --arg dictionary "-ibus-web-rime-dict-$2" \
                'any(.engines[] | select(.name == $engine) | .data[]; endswith($dictionary))' \
                ${fewer}/manifest.json > /dev/null || { echo "$1 lacks $2's dictionary" >&2; exit 1; }
            }
            has rime:luna_pinyin stroke
            has rime:cangjie5 luna_pinyin

            tar -xOzf ${fewerNpm}/*.tgz package/dist/manifest.json | cmp - ${fewer}/manifest.json
            touch $out
          '';
    };
}
