# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{ inputs, ... }:
{
  imports = [ inputs.treefmt-nix.flakeModule ];

  perSystem =
    { config, ... }:
    {
      treefmt = {
        inherit (config.flake-root) projectRootFile;
        programs.nixfmt.enable = true;
        programs.clang-format.enable = true;
        programs.shfmt = {
          enable = true;
          indent_size = 2;
        };
        programs.prettier = {
          enable = true;
          includes = [
            "*.ts"
            "*.mts"
            "*.cts"
            "*.js"
            "*.mjs"
            "*.json"
            "*.yaml"
            "*.yml"
          ];
          # pnpm rewrites its lockfile in its own style on every install.
          excludes = [ "pnpm-lock.yaml" ];
        };
      };
    };
}
