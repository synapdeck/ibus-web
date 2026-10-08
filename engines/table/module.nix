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
      inherit (config.ibusWeb) testing toolchain;

      marisa = pkgs.callPackage ./_marisa.nix { };

      tools = pkgs.stdenv.mkDerivation {
        pname = "ibus-web-table-tools";
        version = "0.1.0";
        src = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [
            ./meson.build
            ./src
            ./native
          ];
        };

        nativeBuildInputs = [
          pkgs.meson
          pkgs.ninja
          pkgs.pkg-config
        ];
        buildInputs = [ marisa ];
      };
    in
    {
      ibusWeb.engines.table = {
        inherit tools;
        sources = lib.filter (lib.hasSuffix ".cpp") (lib.attrNames (builtins.readDir ./src));
      };

      # The engine's sources build for the browser too, so the editor reads
      # them against the WebAssembly MARISA and C++ library. The native
      # checks' GoogleTest headers are the same release's.
      ibusWeb.toolchain.clangdPathFlags."engines/table/.*\\.(cpp|hpp)" = [
        "-std=c++23"
        "-isystem${lib.getDev toolchain.pkgsWasm.marisa}/include"
      ]
      ++ testing.gtestCflagList;
    };
}
