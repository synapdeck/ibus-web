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
      # The IBus layer's private generated header, for editors, without
      # shipping it to engines with the library.
      ibusWeb.toolchain.clangdPathFlags."runtime/libibus-web/src/ibus/.*" = [
        "-I${
          libibus-web.overrideAttrs {
            pname = "libibus-web-private-headers";
            buildPhase = "ninja src/ibus/ibusmarshalers.h";
            installPhase = "install -Dm644 -t $out src/ibus/ibusmarshalers.h";
            dontFixup = true;
          }
        }"
      ];
    };
}
