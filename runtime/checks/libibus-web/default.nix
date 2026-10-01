# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb) toolchain runtime;
      inherit (toolchain) pkgsWasm;
      pkgConfig = "${pkgsWasm.stdenv.cc.targetPrefix}pkg-config";
    in
    {
      checks.libibus-web =
        pkgsWasm.runCommandCC "ibus-web-libibus-web-check"
          {
            nativeBuildInputs = [
              pkgsWasm.nodejs
              pkgsWasm.pkg-config
            ];
            buildInputs = [ runtime.libibusWeb ];
          }
          ''
            $CC -O2 $(${pkgConfig} --cflags libibus-web) -c ${./test-runtime.c} -o test-runtime.o
            $CXX ${toolchain.testMainFlags} test-runtime.o $(${pkgConfig} --libs libibus-web) -o test-runtime.js
            $CC -O2 ${toolchain.sideModuleFlags} $(${pkgConfig} --cflags libibus-web) ${./test-side.c} -o test-side.wasm
            # A lost wakeup leaves the test asleep for good; fail instead.
            timeout 300 node test-runtime.js $PWD/test-side.wasm | tee output.txt
            mkdir -p $out
            cp output.txt $out/
            grep -qx "init 0 1" output.txt
            grep -qx "empty -1" output.txt
            grep -qx "wake 1 1 -1" output.txt
            grep -qx "deadline 1 1 -1" output.txt
            grep -qx "fdpoll 1 1 1 -1" output.txt
            grep -qx "register 0 1 1 1" output.txt
            grep -qx "echo 5 hello" output.txt
            grep -qx "errors 1 1 1 1" output.txt
            grep -qx "side 0 1 4 abab" output.txt
            grep -qx "missing 1" output.txt
          '';
    };
}
