# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb)
        testing
        toolchain
        typescript
        runtime
        ;
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
          config.ibusWeb.engines.wasmJson
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
        "-I${config.ibusWeb.engines.wasmJson}/include/json-glib-1.0"
      ];
      files.file."runtime/libibus-web/include/ibus-web/protocol.h".source = protocolHeader;
      files.file."packages/protocol/PROTOCOL.md".source = protocolDocument;
      checks.protocol-parity = testing.vitestCheck {
        name = "protocol-parity";
        packageDir = "${typescript.workspace}/packages/protocol";
        limit = 600;
        env.IBUS_WEB_PROTOCOL_PARITY = parityManifest;
        inBrowsers = false;
        vitestArgs = [ "test/parity" ];
      };
      checks.protocol = testing.vitestCheck {
        name = "protocol";
        packageDir = "${typescript.workspace}/packages/protocol";
        limit = 600;
        env = { };
        inBrowsers = false;
      };
    };
}
