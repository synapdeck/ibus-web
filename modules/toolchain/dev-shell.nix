# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{ inputs, ... }:
{
  perSystem =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      inherit (config.ibusWeb) toolchain;
      inherit (toolchain.pkgsWasm.stdenv) cc;
      inherit (cc) targetPrefix;
      inherit (pkgs) emscripten;
      pkgConfig = toolchain.pkgsWasm.buildPackages.pkg-config;

      # The cross pkg-config always resolves static linking, which needs
      # every Requires.private module, so propagated inputs are searched too.
      withPropagated =
        drvs:
        lib.unique (
          lib.concatMap (drv: [ drv ] ++ withPropagated (drv.propagatedBuildInputs or [ ])) (
            lib.filter lib.isDerivation drvs
          )
        );
      pkgConfigPath = lib.concatStringsSep ":" (
        map (dir: lib.makeSearchPathOutput "dev" dir (withPropagated toolchain.devLibraries)) [
          "lib/pkgconfig"
          "share/pkgconfig"
        ]
      );

      # Builds get their compilers from stdenv's environment; configuring
      # by hand, Meson needs them named in a cross file.
      mesonBinaries = pkgs.writeText "wasm-shell-meson-binaries.ini" ''
        [binaries]
        c = '${targetPrefix}cc'
        cpp = '${targetPrefix}c++'
        ar = '${targetPrefix}ar'
        nm = '${targetPrefix}nm'
        strip = '${targetPrefix}strip'
        ranlib = '${targetPrefix}ranlib'
        pkg-config = '${targetPrefix}pkg-config'
      '';

      # clangd from the LLVM that emcc drives, so its builtin headers match.
      # It may run the cross compiler to learn its target and system include
      # paths, as for any cross toolchain; clangd only runs drivers it is
      # told to trust.
      clangd = pkgs.writeShellScriptBin "clangd" ''
        exec ${emscripten.llvmEnv}/bin/clangd --query-driver=${cc}/bin/${targetPrefix}* "$@"
      '';

      # Compilation databases name the compiler themselves. Loose sources
      # have none, so they get the cross compiler, the flags every WASM
      # object is built with, and the dev libraries' include paths.
      clangdConfig = pkgs.runCommand "ibus-web-clangd" { PKG_CONFIG_PATH = pkgConfigPath; } ''
        {
          echo "CompileFlags:"
          echo "  Compiler: ${cc}/bin/${targetPrefix}cc"
          echo "  Add:"
          for flag in ${toolchain.commonFlags}; do
            echo "    - \"$flag\""
          done
          modules=""
          for dir in ''${PKG_CONFIG_PATH//:/ }; do
            for pc in "$dir"/*.pc; do
              [ -e "$pc" ] && modules="$modules $(basename "$pc" .pc)"
            done
          done
          if [ -n "$modules" ]; then
            cflags=$(${pkgConfig}/bin/${targetPrefix}pkg-config --cflags $modules)
            for flag in $cflags; do
              echo "    - \"''${flag/#-I/-isystem}\""
            done
          fi
        } > $out
      '';
    in
    {
      devshells.default = {
        packages = [
          cc
          cc.bintools
          pkgConfig
          pkgs.meson
          pkgs.ninja
          clangd
        ];
        env = [
          # Outside a build no stdenv role is active, so the cross pkg-config
          # searches plain PKG_CONFIG_PATH.
          {
            name = "PKG_CONFIG_PATH";
            value = pkgConfigPath;
          }
        ];
        commands = [
          {
            name = "meson-setup-wasm";
            help = "meson setup with pkgsWasm's cross files";
            command = ''exec meson setup ${
              lib.escapeShellArgs (toolchain.mesonCrossFlags ++ [ "--cross-file=${mesonBinaries}" ])
            } "$@"'';
          }
        ];
        devshell.startup.clangd.text = ''
          ln -sfn ${clangdConfig} "$FLAKE_ROOT/.clangd"
        '';
      };

      # Every C and C++ source in the repository must parse cleanly under the
      # editor configuration, so it can't drift from the build.
      checks.clangd = pkgs.runCommand "ibus-web-clangd-check" { } ''
        cp -r --no-preserve=mode ${inputs.self} src
        cd src
        ln -s ${clangdConfig} .clangd
        export HOME=$TMPDIR EM_CACHE=${toolchain.emscriptenCache} EM_FROZEN_CACHE=1
        find . \( -name '*.c' -o -name '*.cpp' \) -print0 |
          while IFS= read -r -d "" file; do
            ${clangd}/bin/clangd --check="$file" --check-locations=false > /dev/null 2> "$TMPDIR/log" || {
              grep '^E\[' "$TMPDIR/log" >&2
              echo "clangd: errors in $file" >&2
              exit 1
            }
          done
        touch $out
      '';
    };
}
