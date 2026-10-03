# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-2.0-or-later
{ lib, withSystem, ... }:
{
  flake.overlays.hangul =
    final: prev:
    lib.optionalAttrs
      (prev.stdenv.hostPlatform.isWasm && (prev.stdenv.hostPlatform.useEmscripten or false))
      {
        ibus-engines = prev.ibus-engines // {
          hangul = withSystem prev.stdenv.buildPlatform.system (
            { config, ... }:
            let
              inherit (config.ibusWeb) runtime toolchain;
              libhangul = final.libhangul.overrideAttrs (old: {
                postPatch = (old.postPatch or "") + ''
                  substituteInPlace hangul/Makefile.am --replace-fail \
                    '$(pkgdatadir)/hanja/hanja.txt' '/usr/share/libhangul/hanja/hanja.txt'
                '';
              });
              layer =
                name:
                lib.filter (p: lib.hasSuffix ".patch" (toString p)) (
                  lib.filesystem.listFilesRecursive (./patches + "/${name}")
                );
              cflags = "-DHAVE_CONFIG_H -I. -Isrc";
              prepare = ''
                cp ${./module.c} module.c
                cat > config.h <<'EOF'
                #define GETTEXT_PACKAGE "ibus-hangul"
                #define IBUSHANGUL_DATADIR "/usr/share/ibus-hangul"
                #define PKGDATADIR "/usr/share/ibus-hangul"
                #define LOCALEDIR "/usr/share/locale"
                #define LIBEXECDIR "/usr/libexec"
                EOF
              '';
            in
            prev.ibus-engines.hangul.overrideAttrs (old: {
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
                cflags="$($PKG_CONFIG --cflags ibus-1.0 libhangul) ${cflags}"
                $CC $cflags -c src/engine.c -o engine.o
                $CC $cflags -c src/ustring.c -o ustring.o
                $CC $cflags -c module.c -o module.o
                libs="$($PKG_CONFIG --static --libs libhangul)"
                source ${runtime.sideModuleLibraryGuard}
                checkSideModuleLibraries $libs
                $CC ${toolchain.sideModuleFlags} engine.o ustring.o module.o $libs -o hangul.wasm
                runHook postBuild
              '';
              installPhase = ''
                runHook preInstall
                install -Dm644 hangul.wasm -t $out
                share=$out/data/usr/share
                install -Dm644 data/symbol.txt -t $share/ibus-hangul/data
                install -Dm644 ${libhangul}/share/libhangul/hanja/hanja.txt -t $share/libhangul/hanja
                schemas=$share/glib-2.0/schemas
                install -Dm644 data/org.freedesktop.ibus.engine.hangul.gschema.xml -t $schemas
                cp ${final.libibus-web}/share/gsettings-schemas/${final.libibus-web.name}/glib-2.0/schemas/*.xml $schemas/
                "$($PKG_CONFIG --variable=glib_compile_schemas gio-2.0)" --strict $schemas
                runHook postInstall
              '';
              passthru = (old.passthru or { }) // {
                auditCflags = cflags;
              };
            })
          );
        };
      };
}
