# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-2.0-or-later
{
  config,
  lib,
  withSystem,
  ...
}:
let
  inherit (config.ibusWeb.lib) isEmscriptenWasm patchesIn;
in
{
  flake.overlays.m17n =
    final: prev:
    lib.optionalAttrs (isEmscriptenWasm prev.stdenv.hostPlatform) (
      withSystem prev.stdenv.buildPlatform.system (
        { config, pkgs, ... }:
        let
          inherit (config.ibusWeb) typescript;

          # A layer with no patch has no directory.
          layer =
            library: name:
            let
              dir = ./patches + "/${library}/${name}";
            in
            lib.optionals (builtins.pathExists dir) (patchesIn dir);

          # The data alone: scripts/ holds shell and awk, which would bring
          # bash and gawk into the module's data closure.
          m17nDb = pkgs.runCommand "ibus-web-m17n-db" { } ''
            mkdir -p $out/share
            cp -r ${pkgs.m17n_db}/share/m17n $out/share/m17n
            chmod -R u+w $out/share/m17n
            rm -r $out/share/m17n/scripts
          '';

          # configure takes M17NDIR, where the library reads its data, from
          # what the m17n-db program prints.
          m17nDbProgram = pkgs.writeShellScriptBin "m17n-db" ''
            echo ${m17nDb}/share/m17n
          '';

          # The flags automake compiles a configured src/'s sources with, as
          # shell words, starting with the options configure added to CC.
          makeCflags = "$(make -s --no-print-directory -f Makefile -f - print-cflags <<< 'print-cflags: ; @echo $(wordlist 2,$(words $(CC)),$(CC)) $(DEFS) $(DEFAULT_INCLUDES) $(INCLUDES) $(AM_CPPFLAGS) $(CPPFLAGS) $(AM_CFLAGS) $(CFLAGS)')";

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
              $CC ${makeCflags} -c descriptors.c -o descriptors.o

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
          descriptors =
            pkgs.runCommand "ibus-web-m17n-descriptors" { nativeBuildInputs = [ typescript.nodejs ]; }
              ''
                node ${descriptorProgram}/descriptors.js > raw.json
                node ${./descriptors/descriptors.ts} raw.json ${lib.escapeShellArg config.ibusWeb.engines.m17n.defaultEngine} $out
                cp raw.json $out/raw.json
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
            m17n = base.overrideAttrs (old: {
              passthru = (old.passthru or { }) // {
                inherit descriptorProgram descriptors;
              };
            });
          };
        }
      )
    );
}
