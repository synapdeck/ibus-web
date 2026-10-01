# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, lib, ... }:
    let
      inherit (config.ibusWeb) toolchain runtime;
      # Array options take a Python list literal, since flags such as
      # -Wl,... rule out Meson's comma-separated form.
      mesonArray = flags: builtins.toJSON (lib.filter (flag: flag != "") (lib.splitString " " flags));
    in
    {
      # libibus-web built with its test suite, which Meson runs under Node,
      # the cross file's exe wrapper. nixpkgs never runs checkPhase when the
      # build machine can't execute host binaries, so the tests run here.
      checks.libibus-web = runtime.libibusWeb.overrideAttrs (old: {
        pname = "ibus-web-libibus-web-check";
        src = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [
            old.passthru.fileset
            ./tests
          ];
        };
        mesonFlags = (old.mesonFlags or [ ]) ++ [
          "-Dtests=true"
          "-Dtest_main_link_args=${mesonArray toolchain.testMainFlags}"
          "-Dtest_side_module_link_args=${mesonArray toolchain.sideModuleFlags}"
        ];
        installPhase = ''
          runHook preInstall
          meson test --no-rebuild --print-errorlogs
          mkdir -p $out
          cp meson-logs/testlog.txt $out/
          runHook postInstall
        '';
      });
    };
}
