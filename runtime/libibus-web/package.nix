# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb.toolchain.pkgsWasm) libibus-web;
    in
    {
      ibusWeb.runtime.libibusWeb = libibus-web;
      ibusWeb.toolchain.devLibraries = [ libibus-web ];
      packages.libibus-web = libibus-web;
      ibusWeb.toolchain.clangdPathFlags."runtime/libibus-web/src/ibus/.*" = [
        "-I${libibus-web}/include/ibus-web/private"
      ];
    };
}
