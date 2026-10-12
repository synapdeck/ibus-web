# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-3.0-or-later
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
      inherit (engines) rime;

      # One engine name a line, from the descriptors the manifest lists.
      names = pkgs.runCommand "ibus-web-rime-engine-names" { nativeBuildInputs = [ pkgs.jq ]; } ''
        jq -r '.[].name' ${rime.descriptors} > $out
      '';

      # The golden tests' harness, from their directory.
      program = testing.program {
        name = "rime-engines";
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
          "--engines"
          "${names}"
        ];
      };
    in
    {
      checks.rime-engines = testing.programs {
        name = "rime-engines";
        programs = [ program ];
        environments = [ "node" ];
      };
    };
}
