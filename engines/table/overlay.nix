# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{ config, lib, ... }:
{
  flake.overlays.table =
    final: prev:
    lib.optionalAttrs (config.ibusWeb.lib.isEmscriptenWasm prev.stdenv.hostPlatform) {
      marisa = final.callPackage ./_marisa.nix { inherit (prev) marisa; };
    };
}
