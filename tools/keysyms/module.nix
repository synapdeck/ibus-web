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
      inherit (config.ibusWeb) typescript testing toolchain;

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
        pkgs.runCommand "ibus-web-${kind}-notice.txt" { } ''
          ${typescript.nodejs}/bin/node ${./notices.ts} ${kind} ${source} > $out
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
            cc -Wall -Wextra -Werror ${./xkb-export.c} $(pkg-config --cflags --libs xkbcommon) -o exporter
            ./exporter ${pkgs.xkeyboard_config}/share/X11/xkb > $out
            XKB_CONFIG_ROOT=/nonexistent XKB_DEFAULT_LAYOUT=de XKB_DEFAULT_OPTIONS=ctrl:nocaps \
              ./exporter ${pkgs.xkeyboard_config}/share/X11/xkb > repeated.json
            cmp $out repeated.json
          '';

      # JSON, which is YAML, rather than pkgs.formats.yaml's output: that opens
      # with a %YAML directive, and the fragment is concatenated mid-file after
      # a `---`, where clangd rejects it. The final newline keeps a following
      # `---` on its own line.
      nativeClangd = pkgs.writeText "ibus-web-xkb-export-clangd.yaml" (
        builtins.toJSON {
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
        }
        + "\n"
      );

      xkbNotice =
        pkgs.runCommand "ibus-web-xkeyboard-config-COPYING.txt" { nativeBuildInputs = [ pkgs.xz ]; }
          ''
            tar -xOf ${pkgs.xkeyboard_config.src} xkeyboard-config-${pkgs.xkeyboard_config.version}/COPYING > $out
          '';

      keysymsWorkspace = typescript.workspaceFor [
        "tools/keysyms"
        "packages/core"
      ];

      keysymdef = "${pkgs.xorgproto}/include/X11/keysymdef.h";

      # oxfmt picks its parser from fileName's extension.
      generate =
        fileName: script: source:
        pkgs.runCommand "ibus-web-${fileName}" { } ''
          ${typescript.nodejs}/bin/node ${script} ${source} \
            | ${pkgs.oxfmt}/bin/oxfmt -c ${../../.oxfmtrc.jsonc} --stdin-filepath ${fileName} > $out
        '';

      # The generator alone, since it imports only its parser.
      keyvalUnicodeGenerator = lib.fileset.toSource {
        root = ./.;
        fileset = lib.fileset.unions [
          ./keysymdef.ts
          ./keyval-unicode.ts
        ];
      };

      keyvalUnicode =
        generate "keyval-unicode.generated.ts" "${keyvalUnicodeGenerator}/keyval-unicode.ts"
          keysymdef;

      # ibus_keyval_to_unicode() for every keyval below the Unicode keysyms and
      # for those around their bounds, as "<keyval> <code point>" in hex.
      ibusKeyvals =
        pkgs.runCommand "ibus-web-ibus-keyvals.txt"
          {
            nativeBuildInputs = [
              pkgs.stdenv.cc
              pkgs.pkg-config
            ];
            buildInputs = [ pkgs.ibus ];
          }
          ''
            cat > dump.c <<'EOF'
            #include <ibus.h>
            #include <stdio.h>

            static void dump(guint first, guint last) {
              for (guint keyval = first; keyval <= last; keyval++)
                printf("%x %x\n", keyval, ibus_keyval_to_unicode(keyval));
            }

            int main(void) {
              dump(0, 0xffff);
              dump(0x1000000, 0x1000400);
              dump(0x100d700, 0x100e100);
              dump(0x110fff0, 0x1110010);
              dump(0x1ffffff, 0x1ffffff);
              return 0;
            }
            EOF
            cc -Wall -Wextra -Werror dump.c $(pkg-config --cflags --libs ibus-1.0) -o dump
            ./dump > $out
          '';

      # The generators' inputs, which the dev shell and the generators' tests read.
      sourcesEnv = {
        IBUS_WEB_CHROMIUM_LICENSE = chromiumLicense;
        IBUS_WEB_KEYSYMDEF = keysymdef;
        IBUS_WEB_DOM_CODES = domCodes;
        IBUS_WEB_XKB_NOTICE = xkbNotice;
        IBUS_WEB_XKB_EXPORT = xkbExport;
      };
    in
    {
      files.file."packages/core/src/keys/keysyms.generated.ts".source =
        generate "keysyms.generated.ts" ./keysymdef.ts
          keysymdef;

      files.file."packages/protocol/src/keyval-unicode.generated.ts".source = keyvalUnicode;

      files.file."packages/core/src/keys/dom-codes.generated.ts".source =
        generate "dom-codes.generated.ts" ./dom-codes.ts
          domCodes;

      files.file."packages/core/src/keys/us.generated.ts".source =
        generate "us.generated.ts" ./us.ts
          xkbExport;

      files.file."runtime/libibus-web/src/ibus/us-keymap.generated.h".source =
        pkgs.runCommand "ibus-web-us-keymap.generated.h" { }
          ''
            ${typescript.nodejs}/bin/node ${keysymsWorkspace}/tools/keysyms/us-c.ts ${xkbExport} ${domCodes} \
              | ${toolchain.emscripten.llvmEnv}/bin/clang-format --assume-filename=us-keymap.generated.h > $out
          '';

      ibusWeb.keysyms.usKeymapVectors = pkgs.runCommand "ibus-web-us-keymap-vectors.txt" { } ''
        ${typescript.nodejs}/bin/node ${keysymsWorkspace}/tools/keysyms/us-vectors.ts ${domCodes} > $out
      '';

      files.file."NOTICES/keysymdef.txt".source = notice "keysymdef" keysymdef;
      files.file."NOTICES/chromium.txt".source = notice "chromium" chromiumLicense;
      files.file."LICENSES/LicenseRef-xkeyboard-config.txt".source = xkbNotice;

      # The generated notices, which the generators' tests compare with the pinned inputs.
      ibusWeb.typescript.extraSources."tools/keysyms" = [
        "LICENSES/LicenseRef-xkeyboard-config.txt"
        "NOTICES/keysymdef.txt"
        "NOTICES/chromium.txt"
      ];

      ibusWeb.toolchain = {
        clangdFragments = [ nativeClangd ];
        clangdQueryDrivers = [ "${pkgs.stdenv.cc}/bin/cc" ];
      };

      devshells.default.env = lib.mapAttrsToList (name: value: { inherit name value; }) sourcesEnv;

      checks = {
        tools-keysyms = testing.vitestCheck {
          name = "tools-keysyms";
          packageDir = "${keysymsWorkspace}/tools/keysyms";
          limit = 120;
          inBrowsers = false;
          env = sourcesEnv;
        };
      }
      # libibus builds only where IBus runs.
      // lib.optionalAttrs (lib.meta.availableOn pkgs.stdenv.hostPlatform pkgs.ibus) {
        tools-keysyms-ibus = pkgs.runCommand "ibus-web-tools-keysyms-ibus" { } ''
          cp ${keyvalUnicode} table.mts
          cp ${./ibus-parity.ts} parity.mts
          ${typescript.nodejs}/bin/node parity.mts ./table.mts ${ibusKeyvals}
          touch $out
        '';
      };
    };
}
