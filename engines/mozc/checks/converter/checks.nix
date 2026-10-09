# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: BSD-3-Clause
{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) toolchain typescript;
      mozc = toolchain.pkgsWasm.mozc;
    in
    {
      # Mozc's converter and session layer, built for WebAssembly, convert
      # romaji with the OSS data set under Node.
      checks.mozc-converter =
        pkgs.runCommand "mozc-converter"
          {
            nativeBuildInputs = [ typescript.nodejs ];
          }
          ''
            mkdir profile
            node ${mozc.check}/converter.js ${mozc.data}/share/mozc/mozc.data "$PWD/profile" kyouhaiitenkidesu \
              > actual 2> log || { cat log; exit 1; }

            cat > expected <<'EOF'
            composition: きょうはいいてんきです
            conversion: 今日はいい天気です
            result: 今日はいい天気です
            EOF
            diff -u expected actual

            touch $out
          '';
    };
}
