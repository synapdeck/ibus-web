# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      inherit (config.ibusWeb)
        testing
        toolchain
        typescript
        runtime
        ;
      flagsConstants =
        pkgs.runCommand "ibus-web-flags.json"
          {
            nativeBuildInputs = [
              pkgs.stdenv.cc
              pkgs.pkg-config
            ];
            buildInputs = [ pkgs.glib ];
          }
          ''
            cc $(pkg-config --cflags glib-2.0 gobject-2.0 gio-2.0) \
              -I${../../runtime/libibus-web/include/ibus-1.0} \
              ${./test/ibus/flags/constants.c} -o constants
            ./constants > $out
          '';
      corpus = pkgs.runCommand "ibus-web-protocol-corpus" { } ''
        ${typescript.nodejs}/bin/node ${typescript.workspace}/packages/protocol/test/parity/write-corpus.ts $out
      '';
      parityOutput = toolchain.pkgsWasm.stdenv.mkDerivation {
        name = "ibus-web-protocol-parity-output";
        src = ./test/parity/c;
        nativeBuildInputs = [
          toolchain.pkgsWasm.pkg-config
          typescript.nodejs
        ];
        buildInputs = [
          runtime.libibusWeb
          testing.jsonGlib
        ];
        dontFixup = true;
        buildPhase = ''
          runHook preBuild
          $CC $($PKG_CONFIG --cflags libibus-web ibus-1.0 json-glib-1.0) -c parity.c -o parity.o
          $CXX ${toolchain.testMainFlags} parity.o \
            $($PKG_CONFIG --static --libs libibus-web ibus-1.0 json-glib-1.0) -o parity.js
          mkdir schemas
          cp parity.gschema.xml schemas/
          $($PKG_CONFIG --variable=glib_compile_schemas gio-2.0) schemas
          runHook postBuild
        '';
        installPhase = ''
          runHook preInstall
          node parity.js ${corpus} $out "$PWD/schemas"
          runHook postInstall
        '';
      };
      parityManifest = pkgs.writeText "ibus-web-protocol-parity.json" (
        builtins.toJSON {
          inherit corpus;
          output = parityOutput;
        }
      );
      protocolHeader = pkgs.runCommand "ibus-web-protocol.h" { } ''
        cp ${../../.clang-format} .clang-format
        ${typescript.nodejs}/bin/node ${typescript.workspace}/packages/protocol/scripts/protocol-h.ts \
          | ${toolchain.emscripten.llvmEnv}/bin/clang-format --assume-filename=protocol.h > $out
      '';
      protocolDocument = pkgs.runCommand "ibus-web-PROTOCOL.md" { } ''
        ${typescript.nodejs}/bin/node ${typescript.workspace}/packages/protocol/scripts/protocol-md.ts \
          | ${pkgs.oxfmt}/bin/oxfmt -c ${../../.oxfmtrc.jsonc} --stdin-filepath PROTOCOL.md > $out
      '';
    in
    {
      ibusWeb.toolchain.clangdPathFlags."packages/protocol/test/parity/c/.*" = [
        "-I${testing.jsonGlib}/include/json-glib-1.0"
      ];
      files.file."runtime/libibus-web/include/ibus-web/protocol.h".source = protocolHeader;
      files.file."packages/protocol/PROTOCOL.md".source = protocolDocument;
      checks.protocol-parity = testing.vitestCheck {
        name = "protocol-parity";
        packageDir = "${typescript.workspace}/packages/protocol";
        limit = 600;
        env.IBUS_WEB_PROTOCOL_PARITY = parityManifest;
        inBrowsers = false;
        # Its suite throws without the manifest, so the check can't pass by skipping it.
        vitestArgs = [
          "--config"
          "vitest.parity.config.ts"
        ];
      };
      checks.protocol = testing.vitestCheck {
        name = "protocol";
        packageDir = "${typescript.workspace}/packages/protocol";
        limit = 600;
        env.IBUS_WEB_FLAGS = flagsConstants;
        inBrowsers = false;
      };
      # Wall-clock timing means nothing on a loaded builder, so the decode benchmark is an app run
      # on demand rather than a check.
      apps.protocol-bench = {
        type = "app";
        program = lib.getExe (
          pkgs.writeShellApplication {
            name = "protocol-bench";
            runtimeInputs = [ typescript.nodejs ];
            text = ''
              HOME=$(mktemp -d)
              export HOME
              trap 'rm -rf "$HOME"' EXIT
              cd ${typescript.workspace}/packages/protocol
              node node_modules/vitest/vitest.mjs run --configLoader native --config vitest.bench.config.ts
            '';
          }
        );
        meta.description = "Time decoding a framed 500-candidate lookup table";
      };
    };
}
