# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb.toolchain) pkgsWasm;
    in
    {
      # GLib's own tests, built by the same recipe with tests enabled and run
      # through Meson's exe wrapper (Node). nixpkgs never runs checkPhase when
      # the build machine can't execute host binaries, so the tests run here.
      checks.glib-tests = pkgsWasm.glib.overrideAttrs (old: {
        pname = "ibus-web-glib-tests";
        mesonFlags = (old.mesonFlags or [ ]) ++ [ "-Dtests=true" ];
        # The tests of GLib's tools run them under Node themselves.
        nativeBuildInputs = (old.nativeBuildInputs or [ ]) ++ [
          pkgsWasm.python3
          pkgsWasm.nodejs
        ];
        outputs = [ "out" ];
        installPhase = ''
          runHook preInstall
          meson test --no-rebuild --print-errorlogs --timeout-multiplier 4 \
            --num-processes $NIX_BUILD_CORES || true
          mkdir -p $out
          cp meson-logs/testlog.json $out/
          python3 ${./gate.py} $out/testlog.json ${./baseline.toml} $out
          runHook postInstall
        '';
        postInstall = "";
        preFixup = "";
        postFixup = "";
      });
    };
}
