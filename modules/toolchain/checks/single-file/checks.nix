# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb) toolchain;
      inherit (toolchain) pkgsWasm;
    in
    {
      # Programs linked through pkgsWasm's compilers carry their WebAssembly
      # in their JavaScript; side modules, and links that opt out, stay
      # separate files. Each program runs from a directory holding nothing
      # else, so nothing it loads can come from beside it.
      checks.toolchain-single-file = pkgsWasm.stdenv.mkDerivation {
        name = "ibus-web-toolchain-single-file";
        src = ./.;
        nativeBuildInputs = [ config.ibusWeb.typescript.nodejs ];

        buildPhase = ''
          runHook preBuild
          $CC -c ${../../probes/probe.c} -o probe.o
          $CC -c main.c -o main.o
          $CC -c side.c -o side.o

          mkdir plain main side opted-out
          $CC -sASSERTIONS=1 probe.o -o plain/plain.js
          $CXX ${toolchain.testMainFlags} main.o -o main/main.js
          $CC ${toolchain.sideModuleFlags} side.o -o side/side.wasm
          $CC -sASSERTIONS=1 -sSINGLE_FILE=0 probe.o -o opted-out/opted-out.js

          listing() {
            (cd "$1" && find . -type f | sort | tr '\n' ' ')
          }
          expect() {
            if [ "$(listing "$1")" != "$2" ]; then
              echo "$1 holds $(listing "$1"), not $2" >&2
              exit 1
            fi
          }
          expect plain "./plain.js "
          expect main "./main.js "
          expect side "./side.wasm "
          expect opted-out "./opted-out.js ./opted-out.wasm "

          test "$(cd plain && node plain.js)" = "probe 7"
          test "$(cd main && node main.js "$PWD/../side/side.wasm")" = "main 42"
          test "$(cd opted-out && node opted-out.js)" = "probe 7"
          runHook postBuild
        '';

        installPhase = "touch $out";
      };
    };
}
