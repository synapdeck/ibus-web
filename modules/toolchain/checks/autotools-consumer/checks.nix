# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb.toolchain) pkgsWasm;
    in
    {
      # The build defines it from what configure's test program reported.
      ibusWeb.toolchain.clangdPathFlags."modules/toolchain/checks/autotools-consumer/src/.*" = [
        "-DCONSUMER_POINTER_SIZE=4"
      ];

      # nixpkgs configures with --build and --host; this proves configure
      # runs its test programs all the same, under Node, and that what one
      # reports reaches the build.
      checks.toolchain-autotools-consumer = pkgsWasm.stdenv.mkDerivation {
        name = "ibus-web-toolchain-autotools-consumer";
        src = ./src;

        nativeBuildInputs = [
          pkgsWasm.buildPackages.autoreconfHook
          config.ibusWeb.typescript.nodejs
        ];

        installPhase = ''
          runHook preInstall
          mkdir -p $out
          node consumer | tee $out/output.txt
          grep -qx "pointer 4" $out/output.txt
          runHook postInstall
        '';
      };
    };
}
