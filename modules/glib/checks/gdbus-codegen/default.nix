# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, lib, ... }:
    let
      inherit (config.ibusWeb.toolchain) pkgsWasm;
      codegen = "${pkgsWasm.glib.dev}/bin/gdbus-codegen";
    in
    {
      # A Meson project generating D-Bus code the way a library built on this
      # GLib would, with the build machine's GLib (and its gdbus-codegen) on
      # hand as well. It declares no build-machine pkg-config or GLib of its
      # own: this GLib's setup hook points Meson at the build machine's GLib
      # version, which gnome.gdbus_codegen() picks its options by.
      checks.glib-gdbus-codegen = pkgsWasm.stdenv.mkDerivation {
        name = "ibus-web-glib-gdbus-codegen";
        src = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [
            ./meson.build
            ./example.xml
            ./main.c
          ];
        };
        nativeBuildInputs = [
          pkgsWasm.meson
          pkgsWasm.ninja
          pkgsWasm.pkg-config
          pkgsWasm.glib
          pkgsWasm.nodejs
        ];
        buildInputs = [ pkgsWasm.glib ];
        installPhase = ''
          runHook preInstall
          grep -qF "${codegen}" build.ninja
          test -s meson-logs/meson-log.txt
          if grep -F "assuming 2.54" meson-logs/meson-log.txt; then
            exit 1
          fi
          mkdir -p $out
          node consumer.js | tee $out/output.txt
          grep -qx "counter 7 /org/example/Counter" $out/output.txt
          runHook postInstall
        '';
      };
    };
}
