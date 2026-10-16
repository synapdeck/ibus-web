# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-2.0-or-later
{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) engines runtime toolchain;
      inherit (config.ibusWeb.lib) emscriptenRoot makeCflags;
      inherit (toolchain.pkgsWasm) m17n_lib ibus-web-m17n-db;
      m17n = toolchain.pkgsWasm.ibus-engines.m17n;

      engineAudit =
        (engines.castAudit {
          name = "m17n";
          inherit (m17n) src buildInputs;
          sources = m17n.auditSources;
          cflags = m17n.auditCflags;
          allowList = ./cast-audit.jsonc;
        }).overrideAttrs
          (old: {
            inherit (m17n) patches postPatch configureFlags;
            nativeBuildInputs = old.nativeBuildInputs ++ m17n.nativeBuildInputs;

            # The flags and config.h come from the engine's own configure run.
            dontConfigure = false;
            preBuild = "cd src";
          });

      # The sources of libm17n-core and libm17n, which the module links, with
      # the flags and config.h of the library's own configure run.
      libAudit =
        (engines.castAudit {
          name = "m17n-lib";
          inherit (m17n_lib) src;
          sources = [
            "character.c"
            "chartab.c"
            "database.c"
            "plist.c"
            "m17n-core.c"
            "mtext.c"
            "symbol.c"
            "textprop.c"
            "mtext-lbrk.c"
            "mtext-wseg.c"
            "charset.c"
            "coding.c"
            "input.c"
            "language.c"
            "locale.c"
            "m17n.c"
          ];
          cflags = makeCflags "AM_CFLAGS";
          allowList = ./m17n-lib-cast-audit.jsonc;
        }).overrideAttrs
          (old: {
            inherit (m17n_lib) patches postPatch configureFlags;
            nativeBuildInputs = old.nativeBuildInputs ++ m17n_lib.nativeBuildInputs;
            dontConfigure = false;
            preBuild = "cd src";
          });
    in
    {
      packages.ibus-web-m17n = m17n;
      packages.ibus-web-m17n-descriptors = m17n.descriptors;

      ibusWeb.engines.m17n = {
        package = m17n;
        descriptors = "${m17n.descriptors}/engines.json";
        settingsPaths = "${m17n.descriptors}/settings-paths.json";

        # Each engine's instance, so that Init declares the 197 of them with
        # one pattern.
        settingsPatterns."org.freedesktop.ibus.engine.m17n" =
          "/org/freedesktop/ibus/engine/m17n/{lang}/{name}/";

        inherit (m17n) settingsSchemaDir;
        settingsSchemas = "${m17n.descriptors}/settings-schemas.json";
      };

      ibusWeb.toolchain.devLibraries = [ m17n_lib ];

      ibusWeb.toolchain.clangdPathFlags."engines/m17n/module/.*\\.c" = [
        "-I${m17n.src}/src"
        "-I${m17n.descriptors}"
        ''-DIBUSWEB_SETTINGS_SCHEMA_DIR="${m17n.settingsSchemaDir}"''
      ];
      ibusWeb.toolchain.clangdPathFlags."engines/m17n/descriptors/descriptors\\.c" = [
        "-I${m17n.src}/src"
      ];

      checks.m17n-imports =
        pkgs.runCommand "ibus-web-m17n-imports" { nativeBuildInputs = [ pkgs.python3 ]; }
          ''
            cat ${
              runtime.checkSideModuleImports {
                name = "m17n";
                modules = [ "${m17n}/m17n.wasm" ];
              }
            } > $out

            # m17n-lib loads no external module, so the module needs nothing of
            # the dynamic loader.
            PYTHONPATH=${emscriptenRoot} python3 - ${m17n}/m17n.wasm >> $out <<'EOF'
            import sys
            from tools import webassembly

            loader = {"dlopen", "dlsym", "dlclose", "dlerror"}
            found = sorted(i.field for i in webassembly.get_imports(sys.argv[1]) if i.field in loader)
            print(f"{sys.argv[1]}: dynamic loader imports: {', '.join(found) or 'none'}")
            sys.exit(1 if found else 0)
            EOF
          '';

      checks.m17n-data-closure = pkgs.runCommand "ibus-web-m17n-data-closure" { } ''
        closure=${pkgs.closureInfo { rootPaths = [ m17n ]; }}/store-paths
        printf '%s\n' ${m17n} ${m17n.data} ${ibus-web-m17n-db} ${m17n.schemas} | sort > expected
        sort "$closure" > actual
        diff -u expected actual

        test -f ${m17n.data}/share/ibus-m17n/default.xml
        test -f ${m17n.settingsSchemaDir}/gschemas.compiled

        while IFS= read -r path; do
          if [ "$path" = ${m17n} ]; then continue; fi
          forbidden=$(find "$path" \( -name lib -o -name include -o -name '*.a' -o -name '*.wasm' -o -name '*.pc' \) -print)
          if [ -n "$forbidden" ]; then echo "non-data closure entries: $forbidden" >&2; exit 1; fi
        done < "$closure"

        cp "$closure" $out
      '';

      checks.m17n-cast-audit = pkgs.linkFarm "ibus-web-m17n-cast-audit" {
        engine = engineAudit;
        m17n-lib = libAudit;
      };
    };
}
