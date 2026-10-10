# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-2.0-or-later
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
      inherit (engines) m17n;

      program = testing.program {
        name = "m17n-golden";
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

        # mplist__from_file keeps a 64 KiB read buffer on the stack, the
        # whole of Emscripten's default.
        linkFlags = config.ibusWeb.lib.testLinkFlagsWithoutNodeFs ++ [
          "-sSTACK_SIZE=1MB"
          "-sDEFAULT_PTHREAD_STACK_SIZE=1MB"
        ];
        args = [
          "--schemas"
          m17n.settingsSchemaDir
          "--module"
          "${m17n.package}/m17n.wasm"
          "--instances"
          "${m17n.package.descriptors}/instances.txt"
        ];
      };
    in
    {
      checks.m17n-golden = testing.programs {
        name = "m17n-golden";
        programs = [ program ];
        environments = [ "node" ];
      };
    };
}
