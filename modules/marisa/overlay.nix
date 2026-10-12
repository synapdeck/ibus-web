# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{ config, lib, ... }:
let
  inherit (config.ibusWeb.lib) isEmscriptenWasm;
in
{
  # One MARISA for every side module that links it; each links its own
  # static copy.
  flake.overlays.marisa =
    final: prev:
    lib.optionalAttrs (isEmscriptenWasm prev.stdenv.hostPlatform) {
      marisa = final.callPackage ./_marisa.nix { inherit (prev) marisa; };
    };
}
