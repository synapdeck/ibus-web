# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{
  perSystem =
    {
      config,
      lib,
      pkgs,
      system,
      ...
    }:
    let
      inherit (config.ibusWeb) testing toolchain typescript;
      inherit (config.ibusWeb.lib) emscriptenRoot;

      # The checker with its package's manifest, which makes it a module, and
      # the dependencies it imports, and nothing else of the workspace, so
      # editing another source rebuilds nothing that runs it.
      checker = pkgs.runCommand "ibus-web-emscripten-library-deps" { } ''
        mkdir $out
        cp ${./library-deps.ts} $out/library-deps.ts
        cp ${./package.json} $out/package.json
        ln -s ${typescript.packageNodeModules ./.} $out/node_modules
      '';
      libraryDeps = "${checker}/library-deps.ts";

      # Types for what a JavaScript library uses from Emscripten, from a link
      # that exports exactly that: Emscripten's own declarations, which
      # --emit-tsd runs tsc over, and globals.d.ts, which declares each export
      # as the global the library's code sees.
      emscriptenTypes =
        {
          name,
          library,
          linkFlags ? [ ],
          buildInputs ? [ ],
        }:
        toolchain.pkgsWasm.stdenv.mkDerivation {
          name = "ibus-web-${name}";
          dontUnpack = true;
          nativeBuildInputs = [
            typescript.nodejs
            typescript.tsc
          ];
          inherit buildInputs;
          dontFixup = true;
          buildPhase = ''
            runHook preBuild
            node ${libraryDeps} emit ${library} ${emscriptenRoot} $out
            $CXX -sASSERTIONS=1 ${lib.escapeShellArgs linkFlags} --no-entry --js-library=${library} \
              -sEXPORTED_RUNTIME_METHODS=$(cat $out/exported-runtime-methods.txt) \
              -sEXPORTED_FUNCTIONS=$(cat $out/exported-functions.txt) \
              --emit-tsd $out/emscripten.d.ts -o probe.js
            runHook postBuild
          '';
          dontInstall = true;
        };
    in
    {
      ibusWeb.lib = { inherit libraryDeps emscriptenTypes; };

      packages = lib.mapAttrs (_: types: types.package) toolchain.emscriptenTypes;

      # Built when the shell starts rather than as part of it, so the shell
      # still enters while a library doesn't build. The out-links keep the
      # types from garbage collection.
      devshells.default.devshell.startup = lib.mapAttrs (name: types: {
        text = ''
          rm -f "$FLAKE_ROOT/${types.link}"
          nix build "$FLAKE_ROOT#packages.${system}.${name}" --out-link "$FLAKE_ROOT/${types.link}" ||
            echo "${name} unavailable" >&2
        '';
      }) toolchain.emscriptenTypes;

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
    };
}
