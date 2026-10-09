# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.keysyms.usKeymapVectors = lib.mkOption {
      type = lib.types.package;
      description = "Expected US keymap lookups, one `evdev state keyval` line each, from the page's own translation.";
    };
  };
}
