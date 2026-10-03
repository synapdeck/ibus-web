# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      inherit (config.ibusWeb) testing typescript;
      toolsSource = lib.fileset.toSource {
        root = ../..;
        fileset = lib.fileset.unions [
          ../../tools/package.json
          ../../tools/vitest.config.ts
          ../../tools/tsconfig.json
          ../../tools/ibus-test
          ../../tsconfig.base.json
          ../../tsconfig.node-scripts.json
        ];
      };
      testTools = pkgs.runCommand "ibus-web-ibus-test-tools" { } ''
        cp -R ${toolsSource} $out
        chmod u+w $out/tools
        ln -s ${typescript.packageNodeModules ../../tools} $out/tools/node_modules
      '';
      native = pkgs.stdenv.mkDerivation {
        pname = "ibus-test-native";
        version = "0.1.0";
        src = ../../tools/ibus-test/native;
        nativeBuildInputs = [
          pkgs.meson
          pkgs.ninja
          pkgs.pkg-config
        ];
        buildInputs = [
          pkgs.glib
          pkgs.json-glib
          pkgs.ibus
        ];
        nativeCheckInputs = [ pkgs.dbus ];
        doCheck = true;
        # nixpkgs otherwise disables Meson's own timeout globally.
        mesonCheckFlags = [ "--timeout-multiplier=1" ];
      };
      nativeClangd =
        pkgs.runCommand "ibus-test-native-clangd"
          {
            inherit (native) buildInputs;
            nativeBuildInputs = [ pkgs.pkg-config ];
          }
          ''
            {
              echo 'If:'
              echo '  PathMatch: tools/ibus-test/native/.*'
              echo 'CompileFlags:'
              echo '  Compiler: ${pkgs.stdenv.cc}/bin/cc'
              echo '  Remove: [-isystem, -fwasm-exceptions, -mextended-const]'
              echo '  Add:'
              for flag in $(pkg-config --cflags gio-2.0 json-glib-1.0 ibus-1.0); do
                echo "    - $flag"
              done
            } > $out
          '';
    in
    {
      ibusWeb.toolchain = lib.mkIf pkgs.stdenv.hostPlatform.isLinux {
        clangdFragments = [ nativeClangd ];
        clangdQueryDrivers = [ "${pkgs.stdenv.cc}/bin/cc" ];
      };
      packages = lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux { ibus-test-native = native; };
      checks = {
        engines-ibus-test-script = testing.vitestCheck {
          name = "engines-ibus-test-script";
          packageDir = "${testTools}/tools";
          env = { };
          inBrowsers = false;
          limit = 60;
          vitestArgs = [ "ibus-test" ];
        };
      }
      // lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
        ibus-test-native = native;
      };
    };
}
