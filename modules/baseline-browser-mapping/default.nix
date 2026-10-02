# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  lib,
  flake-parts-lib,
  ...
}:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.baselineBrowserMapping = lib.mkOption {
      type = lib.types.package;
      description = "baseline-browser-mapping, whose CLI maps a Baseline target to the browser versions that meet it.";
    };
  };

  config.perSystem =
    { pkgs, ... }:
    let
      package = pkgs.callPackage ./_package.nix { };
    in
    {
      ibusWeb.baselineBrowserMapping = package;
      packages.baseline-browser-mapping = package;
    };
}
