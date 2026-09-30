# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{
  perSystem =
    { config, lib, ... }:
    let
      inherit (config.ibusWeb.toolchain) pkgsWasm;
      inherit (pkgsWasm) glib;
      ours = ../patches;
      # GLib's patch list ends with ours; the rest are nixpkgs'.
      nixpkgsPatches = lib.filter (p: !(lib.hasPrefix "${toString ours}/" (toString p))) glib.patches;
    in
    {
      # Applies nixpkgs' own GLib patches and then ours, in the order the
      # build will, so a nixpkgs update that breaks the series fails here
      # with the conflicting hunk rather than deep inside a build.
      checks.glib-patches = pkgsWasm.buildPackages.runCommand "ibus-web-glib-patches" { } ''
        tar -xf ${glib.src}
        cd glib-*
        # Interpolating each patch gives it store context; `toString` on the
        # list would not, and the sandbox would lack the files.
        for p in ${lib.concatMapStringsSep " " (p: "${p}") nixpkgsPatches}; do
          patch -p1 --forward --batch < "$p"
        done
        # No fuzz for ours: a hunk that only lands somewhere nearby after a
        # nixpkgs update should fail here, not apply in the wrong place.
        for p in ${ours}/*.patch; do
          patch -p1 --forward --batch --fuzz=0 < "$p"
        done
        touch $out
      '';
    };
}
