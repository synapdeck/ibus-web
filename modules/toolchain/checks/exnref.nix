# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) toolchain;
    in
    {
      # -fwasm-exceptions emits the legacy encoding, which Firefox warns is
      # deprecated; the standard one waits until every minimum version has it.
      checks.toolchain-exnref =
        pkgs.runCommand "ibus-web-toolchain-exnref-check"
          {
            nativeBuildInputs = [ pkgs.python3 ];
          }
          ''
            python3 ${./exnref.py} \
              ${config.ibusWeb.lib.emscriptenRoot}/tools/feature_matrix.py \
              ${toolchain.minimumVersions}/versions.json
            touch $out
          '';
    };
}
