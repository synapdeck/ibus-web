# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{
  perSystem =
    { config, lib, ... }:
    let
      inherit (config.ibusWeb.toolchain) pkgsWasm;

      # Meson's project() declares the version.
      version =
        let
          versions = lib.concatMap (
            line:
            let
              m = builtins.match " *version: '([^']*)',?" line;
            in
            lib.optional (m != null) (builtins.head m)
          ) (lib.splitString "\n" (builtins.readFile ./libibus-web/meson.build));
        in
        assert lib.length versions == 1;
        builtins.head versions;

      libibusWeb = pkgsWasm.stdenv.mkDerivation {
        pname = "libibus-web";
        inherit version;
        src = lib.fileset.toSource {
          root = ./libibus-web;
          fileset = lib.fileset.unions [
            ./libibus-web/meson.build
            ./libibus-web/include
            ./libibus-web/src
          ];
        };
        nativeBuildInputs = [
          pkgsWasm.meson
          pkgsWasm.ninja
          pkgsWasm.pkg-config
        ];
        # The header includes GLib's, and the static library's users link
        # GLib too.
        propagatedBuildInputs = [ pkgsWasm.glib ];
      };
    in
    {
      ibusWeb.runtime.libibusWeb = libibusWeb;
      ibusWeb.toolchain.devLibraries = [ libibusWeb ];
      packages.libibus-web = libibusWeb;
    };
}
