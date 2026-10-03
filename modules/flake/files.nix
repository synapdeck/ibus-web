# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

# Files the repository must track but Nix generates: `nix run .#write-files`
# writes them, and a check per file fails while a tracked copy differs.
{ inputs, ... }:
{
  imports = [ "${inputs.files}/flake-module.nix" ];

  perSystem =
    { config, ... }:
    {
      files.writer.app = true;
      devshells.default.packages = [ config.files.writer.drv ];
    };
}
