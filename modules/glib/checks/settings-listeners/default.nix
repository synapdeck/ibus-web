# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, lib, ... }:
    let
      inherit (config.ibusWeb) testing toolchain;
      inherit (toolchain) pkgsWasm;
    in
    {
      checks.glib-settings-listeners = pkgsWasm.stdenv.mkDerivation {
        name = "ibus-web-glib-settings-listeners";
        src = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [
            ./meson.build
            ./settings-listeners.c
            ./org.ibus-web.ListenerTest.gschema.xml
          ];
        };
        nativeBuildInputs = [
          pkgsWasm.meson
          pkgsWasm.ninja
          pkgsWasm.pkg-config
        ];
        buildInputs = [ pkgsWasm.glib ];
        mesonFlags = [
          "-Dcpp_link_args=${builtins.toJSON (lib.splitString " " testing.nodeLinkFlags)}"
        ];
        # Cross builds skip checkPhase; Meson's wrapper runs the WASM tests.
        installPhase = ''
          runHook preInstall
          meson test --no-rebuild --print-errorlogs | tee meson-summary.txt
          [ "''${PIPESTATUS[0]}" -eq 0 ]
          if ! grep -Eq '^Ok:[[:space:]]+[1-9]' meson-summary.txt ||
            grep -Eq '^(Skipped|Fail|Timeout|Unexpected Pass|Expected Fail):[[:space:]]+[1-9]' meson-summary.txt; then
            echo "GLib settings listener tests did not all run and pass" >&2
            exit 1
          fi
          mkdir -p $out
          cp meson-logs/testlog.txt $out/
          runHook postInstall
        '';
      };
    };
}
