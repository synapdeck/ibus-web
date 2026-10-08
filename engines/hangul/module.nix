# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-2.0-or-later
{
  perSystem =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      inherit (config.ibusWeb) engines runtime toolchain;
      hangul = toolchain.pkgsWasm.ibus-engines.hangul;
      inherit (hangul) libhangul;

      engineAudit =
        (engines.castAudit {
          name = "hangul";
          inherit (hangul) src buildInputs;
          sources = hangul.auditSources;
          cflags = hangul.auditCflags;
          allowList = ./cast-audit.jsonc;
        }).overrideAttrs
          (old: {
            inherit (hangul)
              patches
              postPatch
              configureFlags
              preConfigure
              ;
            nativeBuildInputs = old.nativeBuildInputs ++ hangul.nativeBuildInputs;

            # The flags and config.h come from the engine's own configure run.
            dontConfigure = false;
            preBuild = "cd src";
          });

      # The sources of the static archive linked into hangul.wasm.
      libhangulAudit =
        (engines.castAudit {
          name = "libhangul";
          inherit (libhangul) src;

          sources = map (source: "hangul/${source}") [
            "hangulctype.c"
            "hangulinputcontext.c"
            "hangulkeyboard.c"
            "hanja.c"
          ];

          # The library's own compile definitions; their values do not affect casts.
          cflags = lib.concatStringsSep " " [
            "-DHAVE_CONFIG_H -I. -Ihangul"
            "'-DLOCALEDIR=\"${libhangul.data}/share/locale\"'"
            "'-DLIBHANGUL_DEFAULT_HANJA_DIC=\"${libhangul.data}/share/libhangul/hanja/hanja.txt\"'"
            "'-DLIBHANGUL_DATA_DIR=\"${libhangul.data}/share/libhangul\"'"
          ];
          allowList = ./libhangul-cast-audit.jsonc;
        }).overrideAttrs
          (old: {
            inherit (libhangul)
              patches
              preAutoreconf
              configureFlags
              ;
            postPatch = libhangul.postPatch or "";
            nativeBuildInputs = old.nativeBuildInputs ++ libhangul.nativeBuildInputs;

            # config.h, including which optional features exist, comes from the
            # library's own configure run.
            dontConfigure = false;
          });
    in
    {
      ibusWeb.engines.hangul = hangul;

      ibusWeb.toolchain.devLibraries = [ libhangul ];

      ibusWeb.toolchain.clangdPathFlags."engines/hangul/module\\.c" = [
        "-I${hangul.src}/src"
        ''-DIBUSWEB_SETTINGS_SCHEMA_DIR="${hangul.settingsSchemaDir}"''
      ];

      packages.ibus-web-hangul = hangul;

      packages.ibus-web-hangul-dist = engines.mkEngineManifest {
        name = "hangul";
        package = hangul;

        # Host conformance peaks at 3,461,120 bytes and uses no engine threads.
        # The manifest builder adds headroom after this whole-MiB declaration.
        threads = 0;
        heapBytes = 4 * 1024 * 1024;

        inherit (hangul) settingsSchemaDir;
        engines = [
          {
            name = "hangul";
            displayName = "Hangul";
            languages = [ "ko" ];
            keyboard = {
              layout = "us";
              passThrough = [ ];
            };
          }
        ];
        settingsSchemas = [
          "org.freedesktop.ibus.engine.hangul"
          "org.freedesktop.ibus.panel"
        ];
      };

      checks.hangul-data-closure = pkgs.runCommand "ibus-web-hangul-data-closure" { } ''
        closure=${pkgs.closureInfo { rootPaths = [ hangul ]; }}/store-paths
        grep -Fx ${hangul.schemas} "$closure"
        test -f ${hangul.settingsSchemaDir}/gschemas.compiled

        while IFS= read -r path; do
          if [ "$path" = ${hangul} ]; then continue; fi
          case "$path" in *-gcc-*|*-clang-*|*-llvm-*|*-emscripten-*) echo "compiler in data closure: $path" >&2; exit 1;; esac
          forbidden=$(find "$path" \( -name lib -o -name include -o -name '*.a' -o -name '*.wasm' -o -name '*.pc' \) -print)
          if [ -n "$forbidden" ]; then echo "non-data closure entries: $forbidden" >&2; exit 1; fi
        done < "$closure"

        cp "$closure" $out
      '';

      checks.hangul-imports = runtime.checkSideModuleImports {
        name = "hangul";
        modules = [ "${hangul}/hangul.wasm" ];
      };

      checks.hangul-cast-audit = pkgs.linkFarm "ibus-web-hangul-cast-audit" {
        engine = engineAudit;
        libhangul = libhangulAudit;
      };
    };
}
