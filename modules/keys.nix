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
      checks.keys-generators = testing.vitestCheck {
        name = "keys-generators";
        packageDir = "${typescript.workspace}/tools";
        limit = 120;
        inBrowsers = false;
        env = {
          IBUS_WEB_KEYSYMDEF = keysymdef;
          IBUS_WEB_DOM_CODES = domCodes;
        };
        vitestArgs = [ "keysyms" ];
      };
    };
}
