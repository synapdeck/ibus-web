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

      # One program, run as each step; the numbered ones share their
      # storage, the working directory, in order.
      program =
        name: step:
        testing.program {
          inherit name;
          derivationName = "ibus-web-test-program-${name}";
          src = ../.;
          sources = [
            "golden/harness.c"
            "userdb/userdb.c"
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
            "--step"
            step
          ];
        };
    in
    {
      checks.rime-userdb = testing.programs {
        name = "rime-userdb";
        programs = [
          (program "rime-userdb.1" "learn")
          (program "rime-userdb.2" "remember")
          (program "rime-userdb.3" "io-error")
          (program "rime-userdb.4" "repair")
          (program "rime-userdb.5" "unrepairable")
          (program "rime-userdb.6" "unrepairable-again")
          (program "rime-userdb-held-failure" "held-failure")
          (program "rime-userdb-compaction" "compact")
        ];
        environments = [ "node" ];
      };
    };
}
