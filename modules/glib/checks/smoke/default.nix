# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb) toolchain;
      inherit (toolchain) pkgsWasm;
      pkgConfig = "${pkgsWasm.stdenv.cc.targetPrefix}pkg-config";
    in
    {
      ibusWeb.toolchain.devLibraries = [ pkgsWasm.glib ];

      checks.glib =
        pkgsWasm.runCommandCC "ibus-web-glib-check"
          {
            nativeBuildInputs = [
              pkgsWasm.nodejs
              pkgsWasm.pkg-config
            ];
            buildInputs = [ pkgsWasm.glib ];
          }
          ''
            $CC -O2 $(${pkgConfig} --cflags gio-2.0) -c ${./glib-test.c} -o glib-test.o
            $CXX ${toolchain.testMainFlags} glib-test.o $(${pkgConfig} --libs gio-2.0) -o glib-test.js
            # A lost wakeup leaves a thread asleep for good; fail instead.
            # A TMPDIR missing on the host is kept in memory.
            TMPDIR=$PWD/tmp timeout 300 node glib-test.js | tee output.txt
            mkdir -p $out
            cp output.txt $out/
            grep -qx "keyfile hangul" output.txt
            grep -qx "regex 288" output.txt
            grep -qx "thread 42" output.txt
            grep -qx "gobject 1" output.txt
            grep -qx "gio gio" output.txt
            grep -qx "exists 1 1 0" output.txt
            grep -qx "mainloop 1" output.txt
            grep -qx "wakeup 1" output.txt
            grep -qx "blocking 1 1 1" output.txt
            grep -qx "worker 7 1" output.txt
            grep -qx "casts abcde" output.txt
            grep -qx "dynamic DynamicThing 1 1" output.txt
            grep -qx "processors yes" output.txt
            grep -qx "signals poke;judge 5;sub-poke;poke;sub-judge;judge 0; 1 0" output.txt
            # GLib's tools are built for WASM too and run under Node.
            mkdir schemas
            echo '<schemalist><schema id="org.example.T"><key name="k" type="b"><default>true</default></key></schema></schemalist>' > schemas/t.gschema.xml
            node ${pkgsWasm.glib.dev}/bin/glib-compile-schemas.js --strict schemas
            test -s schemas/gschemas.compiled
          '';
    };
}
