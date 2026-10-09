# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: BSD-3-Clause
{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) engines runtime toolchain;
      mozc = toolchain.pkgsWasm.mozc;

      # Mozc's default IBus configuration, which its init registers the
      # engines from: the first follows the user's chosen input mode, the
      # others start in hiragana and direct input.
      engine = name: displayName: {
        inherit name displayName;
        languages = [ "ja" ];
        keyboard = {
          layout = "default";
          passThrough = [ ];
        };
      };
    in
    {
      packages.ibus-web-mozc = mozc;

      packages.ibus-web-mozc-dist = engines.mkEngineManifest {
        name = "mozc";
        package = mozc;

        # mozc-host peaks at 39,796,736 bytes asserting and 39,784,448 released,
        # the data set loaded, with one engine thread at most; the manifest
        # builder adds headroom after this whole-MiB declaration.
        threads = 1;
        heapBytes = 40 * 1024 * 1024;

        inherit (mozc) settingsSchemaDir;
        engines = [
          (engine "mozc-jp" "Mozc")
          (engine "mozc-on" "Mozc:あ")
          (engine "mozc-off" "Mozc:A_")
        ];
        settingsSchemas = [ "org.freedesktop.ibus.panel" ];
      };

      # The data closure is the data set and the compiled schema, nothing else.
      checks.mozc-data-closure = pkgs.runCommand "ibus-web-mozc-data-closure" { } ''
        closure=${pkgs.closureInfo { rootPaths = [ mozc ]; }}/store-paths
        grep -Fx ${mozc.data} "$closure"
        grep -Fx ${mozc.schemas} "$closure"
        test "$(wc -l < "$closure")" = 3
        test -f ${mozc.data}/share/mozc/mozc.data
        test -f ${mozc.settingsSchemaDir}/gschemas.compiled

        while IFS= read -r path; do
          if [ "$path" = ${mozc} ]; then continue; fi
          forbidden=$(find "$path" \( -name lib -o -name include -o -name '*.a' -o -name '*.wasm' -o -name '*.pc' \) -print)
          if [ -n "$forbidden" ]; then echo "non-data closure entries: $forbidden" >&2; exit 1; fi
        done < "$closure"

        cp "$closure" $out
      '';

      checks.mozc-imports = runtime.checkSideModuleImports {
        name = "mozc";
        modules = [ "${mozc}/mozc.wasm" ];
      };
    };
}
