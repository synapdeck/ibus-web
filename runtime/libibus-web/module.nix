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
      ibusWeb.toolchain.clangdPathFlags = {
        # The in-tree headers, ahead of the installed library's.
        "runtime/libibus-web/(src|tests)/[^/]+" = [
          "-I../include"
          "-I../include/ibus-1.0"
        ];

        # The IBus layer is compiled as IBus itself, with its private generated
        # header, which engines never get with the library.
        "runtime/libibus-web/src/ibus/.*" = [
          "-DIBUS_COMPILATION"
          "-I../../include/ibus-1.0"
          "-I../../include"
          "-I${
            libibus-web.overrideAttrs {
              pname = "ibus-web-libibus-web-private-headers";
              buildPhase = "ninja src/ibus/ibusmarshalers.h";
              installPhase = "install -Dm644 -t $out src/ibus/ibusmarshalers.h";
              dontFixup = true;
            }
          }"
        ];

        "runtime/libibus-web/include/ibus-1.0/.*" = [ "-DIBUS_COMPILATION" ];
      };
    };
}
