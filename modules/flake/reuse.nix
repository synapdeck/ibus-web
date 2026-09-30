# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{ inputs, ... }:
{
  perSystem =
    { pkgs, ... }:
    {
      # Lints the flake source, which holds exactly the git-tracked files.
      checks.reuse = pkgs.runCommand "ibus-web-reuse" { nativeBuildInputs = [ pkgs.reuse ]; } ''
        reuse --root ${inputs.self} lint
        touch $out
      '';
    };
}
