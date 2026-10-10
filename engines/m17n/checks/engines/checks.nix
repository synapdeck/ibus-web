# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-2.0-or-later
{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb)
        engines
        runtime
        testing
        toolchain
        ;
      inherit (engines) m17n;

      # One engine name a line, from the descriptors the manifest lists.
      names = pkgs.runCommand "ibus-web-m17n-engine-names" { nativeBuildInputs = [ pkgs.jq ]; } ''
        jq -r '.[].name' ${m17n.descriptors} > $out
      '';

      # The golden tests' harness, from their directory.
      program = testing.program {
        name = "m17n-engines";
        src = ../.;
        sources = [
          "golden/harness.c"
          "engines/engines.c"
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
          "--engines"
          "${names}"
        ];
      };
    in
    {
      checks.m17n-engines = testing.programs {
        name = "m17n-engines";
        programs = [ program ];
        environments = [ "node" ];
      };
    };
}
