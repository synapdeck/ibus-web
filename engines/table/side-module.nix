# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) engines runtime toolchain;
      table = toolchain.pkgsWasm.ibus-web-table;
    in
    {
      ibusWeb.engines.table.module = table;

      packages.ibus-web-table = table;

      ibusWeb.toolchain.clangdPathFlags."engines/table/src/glue\\.cpp" = [
        ''-DIBUSWEB_TABLE_DIR="${table.tables}"''
        ''-DIBUSWEB_SETTINGS_SCHEMA_DIR="${table.settingsSchemaDir}"''
      ];

      # The data closure is the tables and the compiled schema, nothing else.
      checks.table-data-closure = pkgs.runCommand "ibus-web-table-data-closure" { } ''
        closure=${pkgs.closureInfo { rootPaths = [ table ]; }}/store-paths
        grep -Fx ${table.tables} "$closure"
        grep -Fx ${table.schemas} "$closure"
        test "$(wc -l < "$closure")" = 3
        test -f ${table.settingsSchemaDir}/gschemas.compiled

        while IFS= read -r path; do
          if [ "$path" = ${table} ]; then continue; fi
          forbidden=$(find "$path" \( -name lib -o -name include -o -name '*.a' -o -name '*.wasm' -o -name '*.pc' \) -print)
          if [ -n "$forbidden" ]; then echo "non-data closure entries: $forbidden" >&2; exit 1; fi
        done < "$closure"

        cp "$closure" $out
      '';

      checks.table-imports = runtime.checkSideModuleImports {
        name = "table";
        modules = [ "${table}/table.wasm" ];
      };

      checks.table-cast-audit = engines.castAudit {
        name = "table";
        inherit (table) src;
        sources = table.auditSources;
        cflags = table.auditCflags;
        buildInputs = [
          runtime.libibusWeb
          toolchain.pkgsWasm.marisa
        ];
        pkgConfigModules = [
          "ibus-1.0"
          "libibus-web"
          "marisa"
        ];
        allowList = ./cast-audit.jsonc;
      };
    };
}
