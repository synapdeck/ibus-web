# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-2.0-or-later
{
  config,
  lib,
  withSystem,
  ...
}:
let
  inherit (config.ibusWeb.lib) isEmscriptenWasm makeCflags patchesIn;
in
{
  flake.overlays.hangul =
    final: prev:
    lib.optionalAttrs (isEmscriptenWasm prev.stdenv.hostPlatform) (
      withSystem prev.stdenv.buildPlatform.system (
        { config, ... }:
        let
          inherit (config.ibusWeb) runtime toolchain;
        in
        {
          # Patched for everything that links it, so a check of the library
          # tests what hangul.wasm ships. Its data goes to an output of its own,
          # which engine distributions carry without the library.
          libhangul = prev.libhangul.overrideAttrs (old: {
            patches = (old.patches or [ ]) ++ patchesIn ./patches/libhangul;
            outputs = (old.outputs or [ "out" ]) ++ [ "data" ];
            configureFlags = (old.configureFlags or [ ]) ++ [
              "--datadir=${placeholder "data"}/share"
              "--localedir=${placeholder "data"}/share/locale"
            ];
          });

          ibus-engines = prev.ibus-engines // {
            hangul =
              let
                inherit (final) libhangul;

                schemas = prev.runCommand "ibus-web-hangul-gsettings-schemas" { } ''
                  mkdir -p $out/share/glib-2.0/schemas
                  cp ${prev.ibus-engines.hangul.src}/data/org.freedesktop.ibus.engine.hangul.gschema.xml $out/share/glib-2.0/schemas/
                  cp ${final.libibus-web}/share/gsettings-schemas/${final.libibus-web.name}/glib-2.0/schemas/org.freedesktop.ibus.gschema.xml \
                    $out/share/glib-2.0/schemas/
                  ${final.glib.dev}/bin/glib-compile-schemas --strict $out/share/glib-2.0/schemas
                '';
                layer = name: patchesIn (./patches + "/${name}");
                settingsSchemaDir = "${schemas}/share/glib-2.0/schemas";

                # The flags automake compiles libinternal.a's sources with, as
                # shell words for a configured src/, starting with the options
                # configure added to CC (the C standard). module.c compiles with
                # them too, plus the schema directory it keeps in the store
                # closure.
                cflags = lib.concatStringsSep " " [
                  (makeCflags "libinternal_a_CFLAGS")
                  "'-DIBUSWEB_SETTINGS_SCHEMA_DIR=\"${settingsSchemaDir}\"'"
                ];

                # Relative to src/, where the flags' include paths resolve.
                sources = [
                  "engine.c"
                  "ustring.c"
                  "module.c"
                ];
              in
              prev.ibus-engines.hangul.overrideAttrs (old: {
                outputs = [
                  "out"
                  "data"
                ];

                patches = (old.patches or [ ]) ++ layer "port" ++ layer "casts";

                nativeBuildInputs = with final.buildPackages; [
                  autoreconfHook
                  gettext
                  pkg-config
                  python3
                ];

                buildInputs = [
                  final.libibus-web
                  libhangul
                ];

                # The static adapter also propagates the desktop recipe's inputs.
                propagatedBuildInputs = [ ];

                configureFlags = (old.configureFlags or [ ]) ++ [
                  "--datadir=${placeholder "data"}/share"
                  "--localedir=${placeholder "data"}/share/locale"
                ];

                # configure requires GTK for the setup tool and its tests, which
                # aren't built. PKG_CHECK_MODULES skips its query when the flags
                # are preset, and takes an empty value as unset.
                preConfigure = (old.preConfigure or "") + ''
                  export GTK_CFLAGS=" " GTK_LIBS=" "
                '';

                postPatch = (old.postPatch or "") + ''
                  cp ${./module.c} src/module.c
                '';

                # ibus-engine-hangul is a desktop process; the side module needs
                # only the engine library and our module.
                buildPhase = ''
                  runHook preBuild
                  cd src
                  make libinternal.a
                  $CC ${cflags} -c module.c -o module.o


                  libs="$($PKG_CONFIG --static --libs libhangul)"
                  source ${runtime.sideModuleLibraryGuard}
                  checkSideModuleLibraries $libs

                  # The archive is the engine itself, not a library to pick
                  # members from.
                  $CC ${toolchain.sideModuleFlags} -g0 -Wl,--whole-archive libinternal.a -Wl,--no-whole-archive \
                    module.o $libs -o hangul.wasm

                  cd ..
                  runHook postBuild
                '';

                installPhase = ''
                  runHook preInstall
                  install -Dm644 src/hangul.wasm -t $out
                  make -C data install-symboltableDATA
                  runHook postInstall
                '';

                passthru = (old.passthru or { }) // {
                  inherit libhangul schemas settingsSchemaDir;
                  auditCflags = cflags;
                  auditSources = sources;
                };
              });
          };
        }
      )
    );
}
