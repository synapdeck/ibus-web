# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{ lib, withSystem, ... }:
{
  flake.overlays.libibus-web =
    final: prev:
    let
      inherit (withSystem prev.stdenv.buildPlatform.system ({ config, ... }: config.ibusWeb.lib))
        isEmscriptenWasm
        ;
    in
    lib.optionalAttrs (isEmscriptenWasm prev.stdenv.hostPlatform) {
      libibus-web = final.callPackage ./_package.nix { };
    };
}
