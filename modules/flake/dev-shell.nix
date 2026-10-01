# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{ inputs, ... }:
{
  imports = [ inputs.devshell.flakeModule ];

  perSystem =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    {
      devshells.default = {
        packages = [
          config.ibusWeb.toolchain.emscripten
          pkgs.nodejs
          config.treefmt.build.wrapper
        ];
        env = [
          {
            name = "FLAKE_ROOT";
            eval = "$(${lib.getExe config.flake-root.package})";
          }
          {
            name = "EM_CACHE";
            eval = "$FLAKE_ROOT/.emcache";
          }
        ];
        # A writable cache in the checkout, seeded from the prebuilt one.
        devshell.startup.emscripten-cache.text = ''
          if [ ! -d "$EM_CACHE" ]; then
            cp -r --no-preserve=mode ${config.ibusWeb.toolchain.emscriptenCache} "$EM_CACHE"
          fi
        '';
      };
    };
}
