# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-2.0-or-later

{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.engines.hangul = lib.mkOption {
      type = lib.types.package;
      description = "The Hangul side module with data-only store references.";
    };
  };
}
