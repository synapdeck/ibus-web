# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { pkgs, ... }:
    {
      ibusWeb.marisa = pkgs.callPackage ./_marisa.nix { };
    };
}
