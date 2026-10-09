# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.engines.mkSettingsMetadata = lib.mkOption {
      type = lib.types.functionTo lib.types.package;
      description = "Generate settings.json from compiled GSettings schemas using pinned GLib: fixed schemas at their paths, relocatable ones at the paths settingsPaths gives.";
    };
  };
  config.perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) toolchain testing typescript;
      inherit (toolchain) pkgsWasm;

      helper = pkgsWasm.stdenv.mkDerivation {
        name = "ibus-web-settings-metadata-helper";
        src = ../../tools/gschema;
        nativeBuildInputs = [
          pkgsWasm.pkg-config
          typescript.nodejs
        ];
        buildInputs = [
          pkgsWasm.glib
          config.ibusWeb.engines.jsonGlib
        ];
        dontFixup = true;
        buildPhase = ''
          runHook preBuild
          $CC $($PKG_CONFIG --cflags gio-2.0 json-glib-1.0) -c metadata.c -o metadata.o
          $CXX ${toolchain.testMainFlags} metadata.o $($PKG_CONFIG --static --libs gio-2.0 json-glib-1.0) -o metadata.js

          mkdir schemas
          cp fixture.gschema.xml schemas/
          $($PKG_CONFIG --variable=glib_compile_schemas gio-2.0) --strict schemas
          runHook postBuild
        '';
        installPhase = ''
          mkdir -p $out
          cp metadata.js metadata.wasm $out/
          cp -R schemas $out/
        '';
      };

      native =
        pkgs.runCommand "ibus-web-settings-metadata-native"
          {
            nativeBuildInputs = [
              pkgs.stdenv.cc
              pkgs.pkg-config
            ];
            buildInputs = [
              pkgs.glib
              pkgs.json-glib
            ];
          }
          ''
            cc ${../../tools/gschema/metadata.c} $(pkg-config --cflags --libs gio-2.0 json-glib-1.0) -o $out
          '';

      fixturePaths = {
        "org.test.Relocatable" = [
          "/org/test/first/"
          "/org/test/second/"
        ];
      };

      fixtureSettings =
        settingsPaths:
        config.ibusWeb.engines.mkSettingsMetadata {
          settingsSchemaDir = "${helper}/schemas";
          settingsSchemas = [
            "org.test.Metadata"
            "org.test.Relocatable"
          ];
          inherit settingsPaths;
        };

      fixture = pkgs.writeText "ibus-web-settings-metadata-fixture.json" (
        builtins.toJSON {
          helper = "${helper}/metadata.js";
          schemas = "${helper}/schemas";
          inherit native;
          settingsFromAttrs = fixtureSettings fixturePaths;
          settingsFromFile = fixtureSettings (
            pkgs.writeText "ibus-web-settings-paths-fixture.json" (builtins.toJSON fixturePaths)
          );
          hangul = config.packages.ibus-web-hangul-dist;
        }
      );
    in
    {
      ibusWeb.engines.mkSettingsMetadata =
        {
          settingsSchemaDir,
          settingsSchemas,
          settingsPaths ? { },
        }:
        let
          # A derivation building the paths is itself an attribute set.
          pathsFile =
            if builtins.isAttrs settingsPaths && !lib.isDerivation settingsPaths then
              pkgs.writeText "ibus-web-settings-paths.json" (builtins.toJSON settingsPaths)
            else
              settingsPaths;
        in
        pkgs.runCommand "ibus-web-settings.json"
          {
            nativeBuildInputs = [
              typescript.nodejs
              pkgs.jq
            ];
          }
          ''
            mapfile -t instances < <(jq -r 'to_entries[] | .key as $id | .value[] | "\($id)=\(.)"' ${pathsFile})
            node ${helper}/metadata.js ${lib.escapeShellArg settingsSchemaDir} ${lib.escapeShellArgs settingsSchemas} "''${instances[@]}" > raw.json
            node ${../../tools/gschema/metadata.ts} ${
              typescript.workspaceFor [ "packages/protocol" ]
            }/packages/protocol/dist/index.js raw.json $out
          '';

      ibusWeb.toolchain.clangdPathFlags."tools/gschema/.*\\.c" = [
        "-I${config.ibusWeb.engines.jsonGlib}/include/json-glib-1.0"
      ];

      checks.engines-settings-metadata = testing.vitestCheck {
        name = "engines-settings-metadata";
        packageDir = "${typescript.workspaceFor [ "tools/gschema" ]}/tools/gschema";
        env.IBUS_WEB_SETTINGS_FIXTURE = fixture;
        inBrowsers = false;
        limit = 60;
      };
    };
}
