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

      # The golden tests' harness, from their directory.
      program = testing.program {
        name = "rime-deploy";
        src = ../.;
        sources = [
          "golden/harness.c"
          "deploy/deploy.c"
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

        # The common data and the compiled schemas at start, as a Worker
        # installs base data, and the descriptors the harness reads;
        # luna_pinyin's dictionaries later.
        args = [
          "--schemas"
          rime.settingsSchemaDir
          "--module"
          "${rime.package}/rime.wasm"
          "--instances"
          "${rime.package.descriptors}/instances.txt"
          "--store-path"
          "${rime.package.common}"
          "--store-path"
          "${rime.package.settingsSchemas}"
          "--store-path"
          "${rime.package.descriptors}"
          "--dictionary"
          "${rime.package.dicts.luna_pinyin}"
          "--dictionary"
          "${rime.package.dicts.stroke}"
        ];
      };
    in
    {
      checks.rime-deploy = testing.programs {
        name = "rime-deploy";
        programs = [ program ];
        environments = [ "node" ];
      };
    };
}
