# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) testing typescript;
      inherit (config.ibusWeb.lib) emscriptenRoot libraryDeps;
      inherit (config.ibusWeb.toolchain) emscripten;
    in
    {
      # The checker itself, over small libraries and over Emscripten's tree
      # with its rules changed.
      checks.tools-emscripten-library-deps = testing.programs {
        name = "tools-emscripten-library-deps";
        environments = [ "node" ];
        programs = [ ];
        nodeTests = ./.;
        nodeTestData = {
          inherit libraryDeps;
          emscripten = emscriptenRoot;
        };
      };

      # The checker parses libraries with the workspace's acorn and Emscripten
      # with its own, and both must read a library alike.
      checks.tools-emscripten-library-deps-acorn =
        pkgs.runCommand "ibus-web-emscripten-library-deps-acorn"
          {
            nativeBuildInputs = [
              typescript.nodejs
              pkgs.jq
            ];
          }
          ''
            expected=$(jq -r .version ${emscriptenRoot}/node_modules/acorn/package.json)
            cd ${typescript.workspace}
            node ${typescript.assertDependency} --locked acorn "$expected" \
              "Emscripten ${emscripten.version} parses libraries with acorn" tools/emscripten-library-deps
            touch $out
          '';
    };
}
