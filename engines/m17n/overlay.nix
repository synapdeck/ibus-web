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
        { pkgs, ... }:
        let
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
        }
      )
    );
}
