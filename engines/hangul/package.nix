# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-2.0-or-later
{
  perSystem =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      inherit (config.ibusWeb) engines runtime toolchain;
      hangul = toolchain.pkgsWasm.ibus-engines.hangul;
      inherit (hangul) libhangul;
      engineAudit =
        (engines.castAudit {
          name = "hangul";
          inherit (hangul) src buildInputs;
          sources = hangul.auditSources;
          cflags = hangul.auditCflags;
          pkgConfigModules = hangul.auditPkgConfigModules;
          allowList = ./cast-audit.jsonc;
        }).overrideAttrs
          {
            inherit (hangul) patches postPatch;
          };
      # The sources of the static archive linked into hangul.wasm.
      libhangulAudit =
        (engines.castAudit {
          name = "libhangul";
          inherit (libhangul) src;
          sources = map (source: "hangul/${source}") [
            "hangulctype.c"
            "hangulinputcontext.c"
            "hangulkeyboard.c"
            "hanja.c"
          ];
          # The library's own compile definitions; their values do not affect casts.
          cflags = lib.concatStringsSep " " [
            "-DHAVE_CONFIG_H -I. -Ihangul"
            "'-DLOCALEDIR=\"/usr/share/locale\"'"
            "'-DLIBHANGUL_DEFAULT_HANJA_DIC=\"/usr/share/libhangul/hanja/hanja.txt\"'"
            "'-DLIBHANGUL_DATA_DIR=\"/usr/share/libhangul\"'"
          ];
          allowList = ./libhangul-cast-audit.jsonc;
        }).overrideAttrs
          (old: {
            inherit (libhangul)
              patches
              postPatch
              preAutoreconf
              configureFlags
              ;
            nativeBuildInputs = old.nativeBuildInputs ++ libhangul.nativeBuildInputs;
            # config.h, including which optional features exist, comes from the
            # library's own configure run.
            dontConfigure = false;
          });
    in
    {
      ibusWeb.engines.hangul = hangul;
      ibusWeb.toolchain.clangdPathFlags."engines/hangul/module\\.c" = [
        "-I${hangul.src}/src"
      ];
      packages.ibus-web-hangul = hangul;
      checks.hangul-imports = runtime.checkSideModuleImports {
        name = "hangul";
        modules = [ "${hangul}/hangul.wasm" ];
      };
      checks.hangul-cast-audit = pkgs.linkFarm "ibus-web-hangul-cast-audit" {
        engine = engineAudit;
        libhangul = libhangulAudit;
      };
    };
}
