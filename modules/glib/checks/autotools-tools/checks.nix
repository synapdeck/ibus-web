# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, lib, ... }:
    let
      inherit (config.ibusWeb.toolchain) pkgsWasm;
      inherit (config.ibusWeb.typescript) nodejs;
      inherit (pkgsWasm) glib pkgsBuildBuild;
    in
    {
      # An Autotools project taking GLib's tools from gio-2.0's variables, as
      # projects built on GLib do, compiling a settings schema and a resource
      # bundle with them and reading both back.
      checks.glib-autotools-tools = pkgsWasm.stdenv.mkDerivation {
        name = "ibus-web-glib-autotools-tools";
        src = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [
            ./configure.ac
            ./Makefile.in
            ./org.example.Tools.gschema.xml
            ./example.gresource.xml
          ];
        };
        nativeBuildInputs = [
          pkgsWasm.autoreconfHook
          pkgsWasm.pkg-config
        ];
        buildInputs = [ glib ];
        # nixpkgs skips checkPhase when the build machine can't run host
        # programs, but these tools run on the build machine.
        installPhase = ''
          runHook preInstall
          grep -qxF "GLIB_COMPILE_SCHEMAS = ${glib.dev}/bin/glib-compile-schemas" Makefile
          grep -qxF "GSETTINGS = ${glib.bin}/bin/gsettings" Makefile
          # The wrappers run on the build machine, with its shell and the workspace's Node.
          for tool in ${glib.dev}/bin/glib-compile-schemas ${glib.bin}/bin/gsettings; do
            test "$(head -n 1 "$tool")" = "#! ${pkgsBuildBuild.runtimeShell} -e"
            grep -qF "${lib.getExe nodejs}" "$tool"
          done
          make check
          # A tool's failure reaches its caller.
          status=0
          ${glib.dev}/bin/glib-compile-schemas missing-directory || status=$?
          test "$status" -eq 1
          mkdir -p $out
          cp -r schemas example.gresource greeting $out/
          runHook postInstall
        '';
      };
    };
}
