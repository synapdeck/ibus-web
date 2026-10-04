# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.testing.jsonGlib = lib.mkOption {
      type = lib.types.package;
      description = "json-glib built for WebAssembly, with which C fixture producers write JSON. The runtime never links it.";
    };
  };

  config.perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb.toolchain) pkgsWasm;
    in
    {
      ibusWeb.testing.jsonGlib = pkgsWasm.stdenv.mkDerivation {
        pname = "ibus-web-json-glib";
        inherit (pkgs.json-glib) version src;
        nativeBuildInputs = [
          pkgs.meson
          pkgs.ninja
          pkgsWasm.pkg-config
        ];
        buildInputs = [ pkgsWasm.glib ];
        mesonFlags = [
          "-Dintrospection=disabled"
          "-Ddocumentation=disabled"
          "-Dtests=false"
          "-Dinstalled_tests=false"
          "-Dnls=disabled"
        ];
      };
    };
}
