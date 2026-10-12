# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-3.0-or-later
{
  perSystem =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      inherit (config.ibusWeb) runtime toolchain;
      inherit (config.ibusWeb.lib) emscriptenRoot;
      rime = toolchain.pkgsWasm.ibus-web-rime;
    in
    {
      packages = {
        ibus-web-rime = rime;
        ibus-web-rime-common = rime.common;
        ibus-web-rime-descriptors = rime.descriptors;
      }
      // lib.mapAttrs' (name: dict: lib.nameValuePair "ibus-web-rime-dict-${name}" dict) rime.dicts;

      ibusWeb.engines.rime = {
        package = rime;
        descriptors = "${rime.descriptors}/engines.json";
        engineData = "${rime.descriptors}/engine-data.json";
        settingsPaths = "${rime.descriptors}/settings-paths.json";
        inherit (rime) settingsSchemaDir;
        settingsSchemas = "${rime.descriptors}/settings-schemas.json";
      };

      ibusWeb.toolchain.devLibraries = [ toolchain.pkgsWasm.librime ];

      ibusWeb.toolchain.clangdPathFlags = {
        "engines/rime/module/.*\\.(c|cc|h)" = [
          "-I${rime.descriptors}"
          "-I${toolchain.pkgsWasm.ibus-engines.rime}/include/ibus-rime"
          "-isystem${toolchain.pkgsWasm.ibus-web-boost-headers}/include"
          ''-DIBUSWEB_RIME_SHARED_DATA_DIR="${rime.common}"''
          ''-DIBUSWEB_SETTINGS_SCHEMA_DIR="${rime.settingsSchemaDir}"''
        ];
        "engines/rime/module/.*\\.cc" = [ "-std=c++17" ];
      };

      checks.rime-imports =
        pkgs.runCommand "ibus-web-rime-imports" { nativeBuildInputs = [ pkgs.python3 ]; }
          ''
            cat ${
              runtime.checkSideModuleImports {
                name = "rime";
                modules = [ "${rime}/rime.wasm" ];
              }
            } > $out

            # OpenCC loads no segmentation plugin and Lua no C module, so the
            # module needs nothing of the dynamic loader.
            PYTHONPATH=${emscriptenRoot} python3 - ${rime}/rime.wasm >> $out <<'EOF'
            import sys
            from tools import webassembly

            loader = {"dlopen", "dlsym", "dlclose", "dlerror"}
            found = sorted(i.field for i in webassembly.get_imports(sys.argv[1]) if i.field in loader)
            print(f"{sys.argv[1]}: dynamic loader imports: {', '.join(found) or 'none'}")
            sys.exit(1 if found else 0)
            EOF
          '';

      # The closure is the module, the common data, every dictionary and the
      # compiled schemas, all of them data.
      checks.rime-data-closure = pkgs.runCommand "ibus-web-rime-data-closure" { } ''
        closure=${pkgs.closureInfo { rootPaths = [ rime ]; }}/store-paths
        printf '%s\n' ${rime} ${rime.common} ${rime.settingsSchemas} \
          ${toString (builtins.attrValues rime.dicts)} | sort > expected
        sort "$closure" > actual
        diff -u expected actual

        test -f ${rime.settingsSchemaDir}/gschemas.compiled
        test -f ${rime.common}/build/default.yaml

        while IFS= read -r path; do
          if [ "$path" = ${rime} ]; then continue; fi
          forbidden=$(find "$path" \( -name lib -o -name include -o -name '*.a' -o -name '*.wasm' -o -name '*.pc' \) -print)
          if [ -n "$forbidden" ]; then echo "non-data closure entries: $forbidden" >&2; exit 1; fi
        done < "$closure"

        # The distribution's archives hold link targets of 100 bytes at most.
        longest=$(find ${rime.common}/build -type l -printf '%l\n' | awk '{ if (length($0) > n) n = length($0) } END { print n }')
        echo "longest link target: $longest bytes"
        { cat "$closure"; echo "longest link target: $longest bytes"; } > $out
      '';
    };
}
