# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: BSD-3-Clause
{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb)
        engines
        runtime
        toolchain
        typescript
        ;
      mozc = toolchain.pkgsWasm.mozc-ut;

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

        # mozc-host's heap peaks at 73,230,464 bytes asserting and 73,236,736
        # released, the data set loaded, with one engine thread at most; the
        # declaration leaves several MiB above that, and the manifest builder
        # adds headroom after it.
        threads = 1;
        heapBytes = 74 * 1024 * 1024;

        inherit (mozc) settingsSchemaDir;
        engines = [
          (engine "mozc-jp" "Mozc")
          (engine "mozc-on" "Mozc:あ")
          (engine "mozc-off" "Mozc:A_")
        ];
        settingsSchemas = [
          "org.freedesktop.ibus.engine.mozc"
          "org.freedesktop.ibus.panel"
        ];
      };

      ibusWeb.demo.modules.mozc = config.packages.ibus-web-mozc-dist;

      # Bazel fetches the libraries Mozc links, Abseil and Protocol Buffers
      # among them, as one fixed-output derivation; the dictionary build
      # reads the UT dictionaries and Japan Post's zip codes.
      ibusWeb.release.engines.mozc = {
        dist = config.packages.ibus-web-mozc-dist;
        module = mozc;
        extraSources = [
          mozc.deps
          toolchain.pkgsWasm.buildPackages.jp-zip-codes
          toolchain.pkgsWasm.buildPackages.merge-ut-dictionaries
        ]
        ++ builtins.attrValues mozc.dictionaries;
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

      # Every source compiled into mozc.wasm, Mozc's, Abseil's, Protocol
      # Buffers' and the module's, audited with the flags its Bazel build
      # compiled it with. The build keeps the reports that found something and
      # the sources they name.
      checks.mozc-cast-audit =
        let
          tools = typescript.workspaceFor [ "tools/cast-audit" ];
          script = "${tools}/tools/cast-audit/cast-audit.ts";
        in
        pkgs.runCommand "ibus-web-mozc-cast-audit" { nativeBuildInputs = [ typescript.nodejs ]; } ''
          mkdir $out
          shopt -s nullglob
          cd ${mozc.casts}/src
          node ${script} report ${mozc.casts}/reports/*.sarif > $out/report.json 2> $out/report.txt
          cat $out/report.txt
          node ${script} compare $out/report.json ${./cast-audit.jsonc}
        '';

      checks.mozc-imports = runtime.checkSideModuleImports {
        name = "mozc";
        modules = [ "${mozc}/mozc.wasm" ];
      };
    };
}
