# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-2.0-or-later
{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) engines toolchain;
      inherit (toolchain.pkgsWasm) m17n_lib;
      m17n = toolchain.pkgsWasm.ibus-engines.m17n;

      # The sources of libm17n-core and libm17n, which the module links, with
      # the flags and config.h of the library's own configure run.
      libAudit =
        (engines.castAudit {
          name = "m17n-lib";
          inherit (m17n_lib) src;
          sources = [
            "character.c"
            "chartab.c"
            "database.c"
            "plist.c"
            "m17n-core.c"
            "mtext.c"
            "symbol.c"
            "textprop.c"
            "mtext-lbrk.c"
            "mtext-wseg.c"
            "charset.c"
            "coding.c"
            "input.c"
            "language.c"
            "locale.c"
            "m17n.c"
          ];
          cflags = "$(make -s --no-print-directory -f Makefile -f - print-cflags <<< 'print-cflags: ; @echo $(wordlist 2,$(words $(CC)),$(CC)) $(DEFS) $(DEFAULT_INCLUDES) $(INCLUDES) $(AM_CPPFLAGS) $(CPPFLAGS) $(AM_CFLAGS) $(CFLAGS)')";
          allowList = ./m17n-lib-cast-audit.jsonc;
        }).overrideAttrs
          (old: {
            inherit (m17n_lib) patches postPatch configureFlags;
            nativeBuildInputs = old.nativeBuildInputs ++ m17n_lib.nativeBuildInputs;
            dontConfigure = false;
            preBuild = "cd src";
          });
    in
    {
      packages.ibus-web-m17n-descriptors = m17n.descriptors;

      ibusWeb.engines.m17n = {
        descriptors = "${m17n.descriptors}/engines.json";
        settingsPaths = "${m17n.descriptors}/settings-paths.json";
        settingsSchemas = "${m17n.descriptors}/settings-schemas.json";
      };

      ibusWeb.toolchain.devLibraries = [ m17n_lib ];

      ibusWeb.toolchain.clangdPathFlags."engines/m17n/descriptors/descriptors\\.c" = [
        "-I${m17n.src}/src"
      ];

      checks.m17n-cast-audit = pkgs.linkFarm "ibus-web-m17n-cast-audit" {
        m17n-lib = libAudit;
      };
    };
}
