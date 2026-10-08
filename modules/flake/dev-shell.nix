# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{ inputs, ... }:
{
  imports = [ inputs.devshell.flakeModule ];

  perSystem =
    { config, lib, ... }:
    {
      # First, so other modules' variables may be set from it.
      devshells.default.env = lib.mkBefore [
        {
          name = "FLAKE_ROOT";
          eval = "$(${lib.getExe config.flake-root.package})";
        }
      ];
    };
}
