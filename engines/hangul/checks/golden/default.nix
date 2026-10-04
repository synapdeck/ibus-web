# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-2.0-or-later
{
  perSystem =
    { config, lib, ... }:
    let
      inherit (config.ibusWeb)
        engines
        runtime
        testing
        toolchain
        ;
      program = testing.program {
        name = "hangul-golden";
        src = ./.;
        sources = [
          "golden.c"
          "harness.c"
        ];
        format = "tap";
        gtest = false;
        nativeBuildInputs = [ toolchain.pkgsWasm.pkg-config ];
        buildInputs = [ runtime.libibusWeb ];
        cflags = "$($PKG_CONFIG --cflags libibus-web ibus-1.0)";
        libs = "$($PKG_CONFIG --static --libs libibus-web)";
        # The memory root keeps writes isolated; store paths stay readable.
        linkFlags = [
          toolchain.commonFlags
        ]
        ++ lib.filter (flag: !(lib.hasSuffix "/node-host-fs.o" flag)) toolchain.testMainFlagList;
        args = [
          "--schemas"
          engines.hangul.settingsSchemaDir
          "--module"
          "${engines.hangul}/hangul.wasm"
        ];
      };
    in
    {
      checks.hangul-golden = testing.programs {
        name = "hangul-golden";
        programs = [ program ];
        environments = [ "node" ];
      };
    };
}
