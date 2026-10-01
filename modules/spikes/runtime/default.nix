# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) toolchain runtime;
      inherit (toolchain) pkgsWasm;

      sides = pkgsWasm.stdenv.mkDerivation {
        name = "ibus-web-runtime-spike-sides";
        src = ../../../tests/spikes/runtime/sides;
        nativeBuildInputs = [ pkgsWasm.pkg-config ];
        buildInputs = [ runtime.libibusWeb ];
        buildPhase = ''
          runHook preBuild
          cflags="$($PKG_CONFIG --cflags libibus-web) ${toolchain.sideModuleFlags}"
          for side in trivial thread fsync; do
            $CC $cflags $side.c -o $side.wasm
          done
          $CXX $cflags throw.cpp -o throw.wasm
          runHook postBuild
        '';
        installPhase = ''
          runHook preInstall
          mkdir -p $out
          cp *.wasm $out/
          runHook postInstall
        '';
      };
    in
    {
      # The asserting runtime loads every spike side module and runs each
      # operation once.
      checks.runtime-spike-smoke =
        pkgs.runCommand "ibus-web-runtime-spike-smoke"
          {
            nativeBuildInputs = [ pkgs.nodejs ];
          }
          ''
            cp ${runtime.nodeHarness}/* .
            cp ${./smoke.mjs} smoke.mjs
            node smoke.mjs ${runtime.ibusRuntimeAsserting}/ibus-runtime.js ${sides} > $out
            cat $out
          '';

      checks.runtime-spike-side-imports = runtime.checkSideModuleImports {
        name = "runtime-spike";
        modules = map (side: "${sides}/${side}.wasm") [
          "trivial"
          "thread"
          "throw"
          "fsync"
        ];
      };
    };
}
