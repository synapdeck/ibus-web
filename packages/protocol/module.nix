# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) testing toolchain typescript;
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
      files.file."runtime/libibus-web/include/ibus-web/protocol.h".source = protocolHeader;
      files.file."packages/protocol/PROTOCOL.md".source = protocolDocument;
      checks.protocol = testing.vitestCheck {
        name = "protocol";
        packageDir = "${typescript.workspace}/packages/protocol";
        limit = 600;
        env = { };
        inBrowsers = false;
      };
    };
}
