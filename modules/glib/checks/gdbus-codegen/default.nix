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
      # hand as well.
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
        # gnome.gdbus_codegen() picks its options by the build machine's GLib
        # version, which Meson reads through a build-machine pkg-config.
        depsBuildBuild = [
          pkgsWasm.pkg-config
          pkgsWasm.glib
        ];
        buildInputs = [ pkgsWasm.glib ];
        installPhase = ''
          runHook preInstall
          grep -qF "${codegen}" build.ninja
          mkdir -p $out
          node consumer.js | tee $out/output.txt
          grep -qx "counter 7 /org/example/Counter" $out/output.txt
          runHook postInstall
        '';
      };
    };
}
