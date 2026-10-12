# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  config,
  lib,
  withSystem,
  ...
}:
let
  inherit (config.ibusWeb.lib) isEmscriptenWasm;
in
{
  flake.overlays.table =
    final: prev:
    lib.optionalAttrs (isEmscriptenWasm prev.stdenv.hostPlatform) (
      withSystem prev.stdenv.buildPlatform.system (
        { config, ... }:
        let
          inherit (config.ibusWeb) runtime toolchain;
        in
        {
          ibus-web-table = final.callPackage ./_package.nix {
            inherit (toolchain) sideModuleFlags;
            inherit (runtime) sideModuleLibraryGuard;
            inherit (config.ibusWeb.engines.table) sources tables;
          };
        }
      )
    );
}
