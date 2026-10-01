# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { lib, pkgs, ... }:
    {
      # nixpkgs applies patches to the source tree it installs whole under
      # share/emscripten, so the system libraries the cache compiles and the
      # JavaScript libraries links read both carry them.
      ibusWeb.toolchain.emscripten = pkgs.emscripten.overrideAttrs (old: {
        patches =
          (old.patches or [ ])
          ++ lib.filter (p: lib.hasSuffix ".patch" (toString p)) (
            lib.filesystem.listFilesRecursive ./patches
          );
      });
    };
}
