# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{ lib, ... }:
{
  flake.overlays.libibus-web =
    final: prev:
    lib.optionalAttrs (
      prev.stdenv.hostPlatform.isWasm && (prev.stdenv.hostPlatform.useEmscripten or false)
    ) { libibus-web = final.callPackage ./_package.nix { }; };
}
