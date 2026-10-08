# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{ config, lib, ... }:
{
  flake.overlays.libibus-web =
    final: prev:
    lib.optionalAttrs (config.ibusWeb.lib.isEmscriptenWasm prev.stdenv.hostPlatform) {
      libibus-web = final.callPackage ./_package.nix { };
    };
}
