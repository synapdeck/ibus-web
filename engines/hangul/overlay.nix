# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-2.0-or-later
{ lib, withSystem, ... }:
{
  flake.overlays.hangul =
    final: prev:
    withSystem prev.stdenv.buildPlatform.system (
      { config, ... }:
      let
        inherit (config.ibusWeb) runtime toolchain;
        inherit (config.ibusWeb.lib) isEmscriptenWasm patchesIn;
      in
      lib.optionalAttrs (isEmscriptenWasm prev.stdenv.hostPlatform) {
        ibus-engines = prev.ibus-engines // {
          hangul =
            let
              libhangul = final.libhangul.overrideAttrs (old: {
                patches = (old.patches or [ ]) ++ [
                  ../../modules/libhangul/patches/0001-buffer-hanja-dictionary-reads.patch
                ];
                outputs = (old.outputs or [ "out" ]) ++ [ "data" ];
                configureFlags = (old.configureFlags or [ ]) ++ [
                  "--datadir=${placeholder "data"}/share"
                  "--localedir=${placeholder "data"}/share/locale"
                ];
              });
              schemas = prev.runCommand "hangul-gsettings-schemas" { } ''
                mkdir -p $out/share/glib-2.0/schemas
                cp ${prev.ibus-engines.hangul.src}/data/org.freedesktop.ibus.engine.hangul.gschema.xml $out/share/glib-2.0/schemas/
                cp ${final.libibus-web}/share/gsettings-schemas/${final.libibus-web.name}/glib-2.0/schemas/org.freedesktop.ibus.gschema.xml \
                  $out/share/glib-2.0/schemas/
                ${final.glib.dev}/bin/glib-compile-schemas --strict $out/share/glib-2.0/schemas
              '';
              layer = name: patchesIn (./patches + "/${name}");
              cflags = "-DHAVE_CONFIG_H -I. -Isrc";
              pkgConfigModules = [
                "ibus-1.0"
                "libhangul"
              ];
              sources = [
                "src/engine.c"
                "src/ustring.c"
                "module.c"
              ];
              prepare = ''
                cp ${./module.c} module.c
                cat > config.h <<EOF
                #define GETTEXT_PACKAGE "ibus-hangul"
                #define IBUSHANGUL_DATADIR "$data/share/ibus-hangul"
                #define PKGDATADIR "$data/share/ibus-hangul"
                #define LOCALEDIR "$data/share/locale"
                #define LIBEXECDIR "/usr/libexec"
                #define IBUSWEB_SETTINGS_SCHEMA_DIR "${schemas}/share/glib-2.0/schemas"
                EOF
              '';
            in
            prev.ibus-engines.hangul.overrideAttrs (old: {
              outputs = [
                "out"
                "data"
              ];
              patches = (old.patches or [ ]) ++ layer "port" ++ layer "casts";
              nativeBuildInputs = [ final.buildPackages.pkg-config ];
              buildInputs = [
                final.libibus-web
                libhangul
              ];
              # The static adapter also propagates the desktop recipe's inputs.
              propagatedBuildInputs = [ ];
              dontConfigure = true;
              postPatch = (old.postPatch or "") + prepare;
              buildPhase = ''
                runHook preBuild
                cflags="$($PKG_CONFIG --cflags ${lib.escapeShellArgs pkgConfigModules}) ${cflags}"
                objects=()
                for source in ${lib.escapeShellArgs sources}; do
                  object="$(basename "$source" .c).o"
                  $CC $cflags -c "$source" -o "$object"
                  objects+=("$object")
                done
                libs="$($PKG_CONFIG --static --libs libhangul)"
                source ${runtime.sideModuleLibraryGuard}
                checkSideModuleLibraries $libs
                $CC ${toolchain.sideModuleFlags} -g0 "''${objects[@]}" $libs -o hangul.wasm
                runHook postBuild
              '';
              installPhase = ''
                runHook preInstall
                install -Dm644 hangul.wasm -t $out
                install -Dm644 data/symbol.txt -t $data/share/ibus-hangul/data
                runHook postInstall
              '';
              passthru = (old.passthru or { }) // {
                inherit libhangul schemas;
                settingsSchemaDir = "${schemas}/share/glib-2.0/schemas";
                auditCflags = cflags;
                auditSources = sources;
                auditPkgConfigModules = pkgConfigModules;
              };
            });
        };
      }
    );
}
