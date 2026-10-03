# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-2.0-or-later
{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb) engines runtime toolchain;
      hangul = toolchain.pkgsWasm.ibus-engines.hangul;
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
      checks.hangul-cast-audit =
        (engines.castAudit {
          name = "hangul";
          inherit (hangul) src buildInputs;
          sources = [
            "src/engine.c"
            "src/ustring.c"
            "module.c"
          ];
          cflags = hangul.auditCflags;
          pkgConfigModules = [
            "ibus-1.0"
            "libhangul"
          ];
          allowList = ./cast-audit.jsonc;
        }).overrideAttrs
          {
            inherit (hangul) patches postPatch;
          };
    };
}
