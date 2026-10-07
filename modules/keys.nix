# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{ inputs, ... }:
{
  perSystem =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      inherit (config.ibusWeb) typescript testing;
      # DEPS.src is the exact source revision of nixpkgs' Chromium build.
      chromiumInfo = lib.importJSON (
        inputs.nixpkgs + "/pkgs/applications/networking/browsers/chromium/info.json"
      );
      chromiumRevision = chromiumInfo.chromium.DEPS.src.rev;
      domCodes = pkgs.fetchurl {
        url = "https://raw.githubusercontent.com/chromium/chromium/${chromiumRevision}/ui/events/keycodes/dom/dom_code_data.inc";
        hash = "sha256-hB4sWOY4jxRzZxfrbjZci46XZ3iONjOb8dNaN6tI5bI=";
      };
      chromiumLicense = pkgs.fetchurl {
        url = "https://raw.githubusercontent.com/chromium/chromium/${chromiumRevision}/LICENSE";
        hash = "sha256-NozKEQa+mdOezTKjjYMFWF2AKkde/7ZjgLkf/JvPcJs=";
      };
      notice =
        kind: source:
        pkgs.runCommand "${kind}-notice.txt" { } ''
          ${typescript.nodejs}/bin/node ${../tools/keysyms/notices.ts} ${kind} ${source} > $out
        '';
      xkbExport =
        pkgs.runCommand "ibus-web-us-keymap.json"
          {
            nativeBuildInputs = [
              pkgs.stdenv.cc
              pkgs.pkg-config
            ];
            buildInputs = [ pkgs.libxkbcommon ];
          }
          ''
            cc -Wall -Wextra -Werror ${../tools/keysyms/xkb-export.c} $(pkg-config --cflags --libs xkbcommon) -o exporter
            ./exporter ${pkgs.xkeyboard_config}/share/X11/xkb > $out
            XKB_CONFIG_ROOT=/nonexistent XKB_DEFAULT_LAYOUT=de XKB_DEFAULT_OPTIONS=ctrl:nocaps \
              ./exporter ${pkgs.xkeyboard_config}/share/X11/xkb > repeated.json
            cmp $out repeated.json
          '';
      nativeClangd = (pkgs.formats.yaml { }).generate "xkb-export-clangd.yaml" {
        If.PathMatch = "tools/keysyms/xkb-export\\.c";
        CompileFlags = {
          Compiler = "${pkgs.stdenv.cc}/bin/cc";
          Remove = [
            "-isystem"
            "-fwasm-exceptions"
            "-mextended-const"
          ];
          Add = [ "-I${lib.getDev pkgs.libxkbcommon}/include" ];
        };
      };
      xkbNotice = pkgs.runCommand "xkeyboard-config-COPYING.txt" { nativeBuildInputs = [ pkgs.xz ]; } ''
        tar -xOf ${pkgs.xkeyboard_config.src} xkeyboard-config-${pkgs.xkeyboard_config.version}/COPYING > $out
      '';
      keysymdef = "${pkgs.xorgproto}/include/X11/keysymdef.h";
      generate =
        name: script: source:
        pkgs.runCommand name { } ''
          ${typescript.nodejs}/bin/node ${script} ${source} \
            | ${pkgs.oxfmt}/bin/oxfmt -c ${../.oxfmtrc.jsonc} --stdin-filepath ${name} > $out
        '';
    in
    {
      files.file."packages/core/src/keys/keysyms.generated.ts".source =
        generate "keysyms.generated.ts" ../tools/keysyms/keysymdef.ts
          keysymdef;
      files.file."packages/core/src/keys/dom-codes.generated.ts".source =
        generate "dom-codes.generated.ts" ../tools/keysyms/dom-codes.ts
          domCodes;
      files.file."packages/core/src/keys/us.generated.ts".source =
        generate "us.generated.ts" ../tools/keysyms/us.ts
          xkbExport;
      files.file."NOTICES/keysymdef.txt".source = notice "keysymdef" keysymdef;
      files.file."NOTICES/chromium.txt".source = notice "chromium" chromiumLicense;
      files.file."LICENSES/LicenseRef-xkeyboard-config.txt".source = xkbNotice;
      ibusWeb.toolchain = {
        clangdFragments = [ nativeClangd ];
        clangdQueryDrivers = [ "${pkgs.stdenv.cc}/bin/cc" ];
      };
      devshells.default.env = [
        {
          name = "IBUS_WEB_CHROMIUM_LICENSE";
          value = chromiumLicense;
        }
        {
          name = "IBUS_WEB_KEYSYMDEF";
          value = keysymdef;
        }
        {
          name = "IBUS_WEB_DOM_CODES";
          value = domCodes;
        }
        {
          name = "IBUS_WEB_XKB_NOTICE";
          value = xkbNotice;
        }
        {
          name = "IBUS_WEB_XKB_EXPORT";
          value = xkbExport;
        }
      ];
      checks.keys-generators =
        (testing.vitestCheck {
          name = "keys-generators";
          packageDir = "${typescript.workspaceFor [ "tools/keysyms" ]}/tools/keysyms";
          limit = 120;
          inBrowsers = false;
          env = {
            # Use the pinned pnpm binary without bootstrapping another copy from npm.
            pnpm_config_pm_on_fail = "ignore";
            IBUS_WEB_CHROMIUM_LICENSE = chromiumLicense;
            IBUS_WEB_KEYSYMDEF = keysymdef;
            IBUS_WEB_XKB_EXPORT = xkbExport;
            IBUS_WEB_XKB_NOTICE = xkbNotice;
            IBUS_WEB_DOM_CODES = domCodes;
          };
        }).overrideAttrs
          (old: {
            nativeBuildInputs = old.nativeBuildInputs ++ [ pkgs.pnpm ];
          });
    };
}
