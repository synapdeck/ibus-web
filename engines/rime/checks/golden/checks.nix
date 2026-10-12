# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-3.0-or-later
{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb)
        engines
        runtime
        testing
        toolchain
        ;
      inherit (engines) rime;

      program = testing.program {
        name = "rime-golden";
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

        linkFlags = config.ibusWeb.lib.testLinkFlagsWithoutNodeFs ++ [
          "-sSTACK_SIZE=1MB"
          "-sDEFAULT_PTHREAD_STACK_SIZE=1MB"
        ];
        args = [
          "--schemas"
          rime.settingsSchemaDir
          "--module"
          "${rime.package}/rime.wasm"
          "--instances"
          "${rime.package.descriptors}/instances.txt"
        ];
      };
    in
    {
      checks.rime-golden = testing.programs {
        name = "rime-golden";
        programs = [ program ];
        environments = [ "node" ];
      };
    };
}
