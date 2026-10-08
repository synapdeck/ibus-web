# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb) toolchain;
    in
    {
      devshells.default = {
        packages = [ toolchain.emscripten ];

        env = [
          {
            name = "EM_CACHE";
            eval = "$FLAKE_ROOT/.emcache";
          }
        ];

        # A writable cache in the checkout, seeded from the prebuilt one.
        devshell.startup.emscripten-cache.text = ''
          if [ ! -d "$EM_CACHE" ]; then
            cp -r --no-preserve=mode ${toolchain.emscriptenCache} "$EM_CACHE"
          fi
        '';
      };
    };
}
