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
  flake.overlays.m17n =
    final: prev:
    lib.optionalAttrs (isEmscriptenWasm prev.stdenv.hostPlatform) (
      withSystem prev.stdenv.buildPlatform.system (
        { config, pkgs, ... }:
        let
          inherit (config.ibusWeb) runtime toolchain typescript;

          # A layer with no patch has no directory.
          layer =
            library: name:
            let
              dir = ./patches + "/${library}/${name}";
            in
            lib.optionals (builtins.pathExists dir) (patchesIn dir);

          # Native m17n-lib's entries for every input method of m17n-db:
          # each one's tags, file and required version, as m17n reads them
          # from the files' headers.
          inputMethodEntries =
            pkgs.runCommandCC "ibus-web-m17n-input-methods" { buildInputs = [ pkgs.m17n_lib ]; }
              ''
                $CC ${./mdb-dir/mdb-dir.c} -lm17n -lm17n-core -o mdb-dir
                M17NDIR=${pkgs.m17n_db}/share/m17n ./mdb-dir | sort > $out
              '';

          # The data alone: scripts/ holds shell and awk, which would bring
          # bash and gawk into the module's data closure. mdb.dir names each
          # input method's file in place of the wildcard, which m17n expands
          # by reading every input method's file to its end the first time it
          # looks any of them up.
          m17nDb = pkgs.runCommand "ibus-web-m17n-db" { } ''
            mkdir -p $out/share
            cp -r ${pkgs.m17n_db}/share/m17n $out/share/m17n
            chmod -R u+w $out/share/m17n
            rm -r $out/share/m17n/scripts

            awk -v entries=${inputMethodEntries} '
              $0 == "(input-method * \"*.mim\")" {
                while ((getline line < entries) > 0) print line
                replaced++
                next
              }
              { print }
              END { exit replaced != 1 }
            ' ${pkgs.m17n_db}/share/m17n/mdb.dir > $out/share/m17n/mdb.dir
          '';

          # configure takes M17NDIR, where the library reads its data, from
          # what the m17n-db program prints.
          m17nDbProgram = pkgs.writeShellScriptBin "m17n-db" ''
            echo ${m17nDb}/share/m17n
          '';

          # ibus-m17n's configured tree, from which the descriptor program and
          # the side module each build their part.
          base = prev.ibus-engines.m17n.overrideAttrs (old: {
            patches = (old.patches or [ ]) ++ layer "ibus-m17n" "port" ++ layer "ibus-m17n" "casts";

            outputs = [
              "out"
              "data"
            ];

            nativeBuildInputs = with final.buildPackages; [
              autoreconfHook
              gettext
              pkg-config
            ];

            buildInputs = [
              final.libibus-web
              final.m17n_lib
            ];

            # The static adapter also propagates the desktop recipe's inputs.
            propagatedBuildInputs = [ ];

            # Without the setup tool's GTK. LIBEXECDIR is only in that tool's
            # command line; outside the store, it keeps the module from
            # referring to its own output.
            configureFlags = [
              "--with-gtk=no"
              "--libexecdir=/usr/libexec"
              "--disable-nls"
              "--datadir=${placeholder "data"}/share"
            ];
          });

          # Built from the same tree as m17n.wasm but apart from it, so that
          # the schemas m17n.wasm compiles in can come from what it prints.
          descriptorProgram = base.overrideAttrs (old: {
            pname = "ibus-web-m17n-descriptor-program";

            postPatch = (old.postPatch or "") + ''
              cp ${./descriptors/descriptors.c} src/descriptors.c
            '';

            # A main module links every archive whole, so an archive m17n-shell
            # names twice, directly and through m17n-core, is named once.
            # mplist__from_file keeps a 64 KiB read buffer on the stack, the
            # whole of Emscripten's default.
            buildPhase = ''
              runHook preBuild
              cd src
              make libm17ncommon.la
              $CC ${makeCflags "AM_CFLAGS"} -c descriptors.c -o descriptors.o

              libs=$($PKG_CONFIG --static --libs libibus-web m17n-shell | tr ' ' '\n' | awk 'NF && !seen[$0]++' | tr '\n' ' ')
              $CXX ${toString config.ibusWeb.lib.testLinkFlagsWithoutNodeFs} -sSTACK_SIZE=1MB -sDEFAULT_PTHREAD_STACK_SIZE=1MB \
                descriptors.o .libs/libm17ncommon.a $libs -o descriptors.js

              cd ..
              runHook postBuild
            '';

            # default.xml goes where the program's PKGDATADIR points.
            installPhase = ''
              runHook preInstall
              install -Dm644 -t $out src/descriptors.js src/descriptors.wasm
              install -Dm644 src/default.xml -t $data/share/ibus-m17n
              runHook postInstall
            '';

            dontFixup = true;
          });

          # The step's files, with the program's own output beside them.
          # engines.xml is the listing's index, read from every input
          # method's file: the program's own data directory holds no index.
          descriptors =
            pkgs.runCommand "ibus-web-m17n-descriptors" { nativeBuildInputs = [ typescript.nodejs ]; }
              ''
                node ${descriptorProgram}/descriptors.js > raw.json
                node ${./descriptors/descriptors.ts} raw.json ${lib.escapeShellArg config.ibusWeb.engines.m17n.defaultEngine} $out
                cp raw.json $out/raw.json
                node ${descriptorProgram}/descriptors.js --index > $out/engines.xml
              '';
        in
        {
          ibus-web-m17n-db = m17nDb;

          # Patched for everything that links it.
          m17n_lib = prev.m17n_lib.overrideAttrs (old: {
            patches = (old.patches or [ ]) ++ layer "m17n-lib" "port" ++ layer "m17n-lib" "casts";

            nativeBuildInputs = [
              final.buildPackages.autoreconfHook
              final.buildPackages.pkg-config
              m17nDbProgram
            ];

            # The example programs and their external modules are no part of
            # the library.
            postPatch = (old.postPatch or "") + ''
              substituteInPlace Makefile.am --replace-fail 'SUBDIRS = intl po src example' 'SUBDIRS = intl po src'
            '';

            configureFlags = (old.configureFlags or [ ]) ++ [
              # configure reads with_gui: --without-gui skips the GUI and
              # font-layout libraries' checks, and the rest say no to each
              # in case one runs anyway.
              "--without-gui"
              "--without-libotf"
              "--without-fontconfig"
              "--without-gd"
              "--without-x"
              "--disable-nls"
              # Found through programs and test links the build machine could
              # answer; none serves an input method.
              "ac_cv_prog_HAVE_XML2_CONFIG=no"
              "ac_cv_lib_xml2_xmlParseMemory=no"
              "ac_cv_prog_HAVE_ISPELL=no"
              "ac_cv_lib_wordcut_wordcut_init=no"
              # A cross build can't run these tests, and would substitute
              # rpl_malloc and rpl_realloc, which m17n-lib doesn't define;
              # Emscripten's malloc(0) and realloc(NULL, 0) return pointers.
              "ac_cv_func_malloc_0_nonnull=yes"
              "ac_cv_func_realloc_0_nonnull=yes"
              # No external module can be loaded: there is no module
              # directory, and each attempt would print the loader's error.
              "ac_cv_search_dlopen=no"
            ];
          });

          ibus-engines = prev.ibus-engines // {
            m17n =
              let
                inherit (final) m17n_lib;

                # ibus-m17n's relocatable schema, the panel's and the input
                # methods' variable schemas, compiled together.
                schemas = prev.runCommand "ibus-web-m17n-gsettings-schemas" { } ''
                  mkdir -p $out/share/glib-2.0/schemas
                  cp ${prev.ibus-engines.m17n.src}/src/org.freedesktop.ibus.engine.m17n.gschema.xml $out/share/glib-2.0/schemas/
                  cp ${final.libibus-web}/share/gsettings-schemas/${final.libibus-web.name}/glib-2.0/schemas/org.freedesktop.ibus.gschema.xml \
                    $out/share/glib-2.0/schemas/
                  cp ${descriptors}/schemas/*.gschema.xml $out/share/glib-2.0/schemas/
                  ${final.glib.dev}/bin/glib-compile-schemas --strict $out/share/glib-2.0/schemas
                '';
                settingsSchemaDir = "${schemas}/share/glib-2.0/schemas";

                # Our sources compile with the flags make used for
                # libm17ncommon, plus the schema directory module.c keeps in
                # the store closure and the table variables.c reads.
                cflags = lib.concatStringsSep " " [
                  (makeCflags "AM_CFLAGS")
                  "'-DIBUSWEB_SETTINGS_SCHEMA_DIR=\"${settingsSchemaDir}\"'"
                  "-I${descriptors}"
                ];

                # Relative to src/, where the flags' include paths resolve.
                sources = [
                  "m17nutil.c"
                  "engine.c"
                  "module.c"
                  "variables.c"
                ];
              in
              base.overrideAttrs (old: {
                postPatch = (old.postPatch or "") + ''
                  cp ${./module/module.c} src/module.c
                  cp ${./module/variables.c} src/variables.c
                  cp ${./module/variables.h} src/variables.h
                '';

                # ibus-engine-m17n is a desktop process; the side module needs
                # only libm17ncommon, the engine and our module.
                buildPhase = ''
                  runHook preBuild
                  cd src
                  make libm17ncommon.la
                  $CC ${cflags} -c engine.c -o engine.o
                  $CC ${cflags} -c module.c -o module.o
                  $CC ${cflags} -c variables.c -o variables.o

                  libs="$($PKG_CONFIG --static --libs m17n-shell)"
                  source ${runtime.sideModuleLibraryGuard}
                  checkSideModuleLibraries $libs

                  # The archive is the engine's own code, not a library to
                  # pick members from.
                  $CC ${toolchain.sideModuleFlags} -g0 -Wl,--whole-archive .libs/libm17ncommon.a -Wl,--no-whole-archive \
                    engine.o module.o variables.o $libs -o m17n.wasm

                  cd ..
                  runHook postBuild
                '';

                installPhase = ''
                  runHook preInstall
                  install -Dm644 src/m17n.wasm -t $out
                  install -Dm644 src/default.xml ${descriptors}/engines.xml -t $data/share/ibus-m17n
                  runHook postInstall
                '';

                # m17n-lib is linked into the module and m17n-db's input
                # methods are its data, both LGPL-2.1-or-later.
                meta = old.meta // {
                  license = with lib.licenses; [
                    gpl2Plus
                    lgpl21Plus
                  ];
                };

                passthru = (old.passthru or { }) // {
                  inherit
                    m17n_lib
                    inputMethodEntries
                    schemas
                    settingsSchemaDir
                    descriptorProgram
                    descriptors
                    ;
                  auditCflags = cflags;
                  auditSources = sources;
                };
              });
          };
        }
      )
    );
}
