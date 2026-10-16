# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) toolchain;

      # Copies the frozen cache to a writable directory, and copies it again
      # once the frozen cache is another store path, so the copy never lags
      # the toolchain. The copy names the cache it came from; one that names
      # none predates the record and is replaced too.
      seedCache = pkgs.writeShellScript "ibus-web-seed-emcache" ''
        target=$1
        cache=$2
        record=$target/.ibus-web-frozen-cache

        if [ ! -d "$target" ] || [ "$(cat "$record" 2>/dev/null)" != "$cache" ]; then
          rm -rf "$target"
          cp -r --no-preserve=mode "$cache" "$target" && echo "$cache" > "$record"
        fi
      '';
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

        devshell.startup.emscripten-cache.text = ''
          ${seedCache} "$EM_CACHE" ${toolchain.emscriptenCache}
        '';
      };

      # Two stand-in caches: a first seed, a rerun on the same cache that
      # keeps what the shell's builds added, and a rerun on another.
      checks.emscripten-dev-cache =
        let
          cache =
            name:
            pkgs.runCommand "ibus-web-emcache-${name}" { } ''
              mkdir -p $out/sysroot
              echo ${name} > $out/sysroot/${name}.a
            '';
          first = cache "first";
          second = cache "second";
        in
        pkgs.runCommand "ibus-web-emscripten-dev-cache" { } ''
          ${seedCache} emcache ${first}
          test "$(cat emcache/sysroot/first.a)" = first
          test -w emcache/sysroot/first.a

          echo built > emcache/sysroot/built.a
          ${seedCache} emcache ${first}
          test -e emcache/sysroot/built.a

          ${seedCache} emcache ${second}
          test "$(cat emcache/sysroot/second.a)" = second
          test ! -e emcache/sysroot/first.a
          test ! -e emcache/sysroot/built.a

          rm emcache/.ibus-web-frozen-cache
          echo built > emcache/sysroot/built.a
          ${seedCache} emcache ${second}
          test ! -e emcache/sysroot/built.a
          touch $out
        '';
    };
}
