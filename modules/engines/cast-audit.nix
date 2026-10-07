# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      inherit (config.ibusWeb) testing toolchain typescript;
      inherit (toolchain) pkgsWasm;
      toolsSource = lib.fileset.toSource {
        root = ../..;
        fileset = lib.fileset.unions [
          ../../tools/package.json
          ../../tools/vitest.config.ts
          ../../tools/tsconfig.json
          ../../tools/cast-audit
        ];
      };
      auditTools = pkgs.runCommand "ibus-web-cast-audit-tools" { } ''
        cp -R ${toolsSource} $out
        chmod u+w $out/tools
        ln -s ${typescript.packageNodeModules ../../tools} $out/tools/node_modules
        chmod u+w $out
        mkdir -p $out/node_modules/@ibus-web
        cp -R ${typescript.presets} $out/node_modules/@ibus-web/tsconfig
      '';
      script = "${auditTools}/tools/cast-audit/cast-audit.ts";
      castAudit =
        {
          name,
          src,
          sources,
          cflags ? "",
          buildInputs ? [ ],
          pkgConfigModules ? [ ],
          allowList,
        }:
        pkgsWasm.stdenv.mkDerivation {
          name = "ibus-web-${name}-cast-audit";
          inherit src buildInputs;
          nativeBuildInputs = [
            pkgsWasm.buildPackages.pkg-config
            typescript.nodejs
          ];
          dontConfigure = true;
          dontFixup = true;
          buildPhase = ''
            runHook preBuild
            reports=()
            cflags=(${cflags})
            ${lib.optionalString (pkgConfigModules != [ ]) ''
              read -r -a pkgFlags <<< "$($PKG_CONFIG --cflags ${lib.escapeShellArgs pkgConfigModules})"
              cflags+=("''${pkgFlags[@]}")
            ''}
            for source in ${lib.escapeShellArgs sources}; do
              report="$TMPDIR/casts-''${#reports[@]}.sarif"
              $CC -fsyntax-only -Wno-everything -Wcast-function-type-strict \
                -fdiagnostics-format=sarif "''${cflags[@]}" "$source" 2> "$report" || {
                cat "$report" >&2
                exit 1
              }
              reports+=("$report")
            done
            mkdir $out
            node ${script} report "''${reports[@]}" > $out/report.json 2> $out/report.txt
            cat $out/report.txt
            runHook postBuild
          '';
          installPhase = ''
            runHook preInstall
            node ${script} compare $out/report.json ${allowList}
            runHook postInstall
          '';
        };
      fixture = castAudit {
        name = "fixture";
        src = ../../tools/cast-audit/fixtures;
        sources = [ "casts.c" ];
        buildInputs = [ pkgsWasm.glib ];
        pkgConfigModules = [ "gobject-2.0" ];
        allowList = ../../tools/cast-audit/fixtures/allow.jsonc;
      };
    in
    {
      ibusWeb.engines.castAudit = castAudit;
      checks.engines-cast-audit-script = testing.vitestCheck {
        name = "engines-cast-audit-script";
        packageDir = "${auditTools}/tools";
        env = { };
        inBrowsers = false;
        limit = 60;
      };
      checks.engines-cast-audit-fixture = fixture.overrideAttrs {
        postInstall = ''
          if node ${script} compare $out/report.json ${../../tools/cast-audit/fixtures/empty.jsonc} \
            > $out/rejected.txt 2>&1; then
            echo "an empty allow-list incorrectly accepted the incompatible cast" >&2
            exit 1
          fi
          cat $out/rejected.txt
          # Prove the directly called zero-argument mismatch fails by itself.
          node ${auditTools}/tools/cast-audit/select.ts $out/report.json takes_int > $out/direct.json
          if node ${script} compare $out/direct.json ${../../tools/cast-audit/fixtures/empty.jsonc} \
            > $out/direct-rejected.txt 2>&1; then
            echo "an empty allow-list incorrectly accepted the direct-call mismatch" >&2
            exit 1
          fi
          cat $out/direct-rejected.txt
        '';
      };
    };
}
