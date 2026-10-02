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
      inherit (config.ibusWeb) runtime typescript;
      inherit (config.ibusWeb.toolchain) pkgsWasm emscripten;
      inherit (runtime) wasmfsIdb;

      # Where the type check and the editor find these types, relative to the
      # library's sources; tsconfig.json names it.
      typesDir = "emscripten-types";

      # Types for what the JavaScript library uses from Emscripten, from a
      # link that exports exactly that: Emscripten's own declarations, which
      # --emit-tsd runs tsc over, and globals.d.ts, which declares each
      # export as the global the library's code sees.
      types = pkgsWasm.stdenv.mkDerivation {
        name = "ibus-web-wasmfs-idb-types";
        dontUnpack = true;
        nativeBuildInputs = [
          typescript.nodejs
          typescript.tsc
        ];
        buildInputs = [ wasmfsIdb ];
        dontFixup = true;
        buildPhase = ''
          runHook preBuild
          node ${./library-deps.mjs} emit ${wasmfsIdb.jsLibrary} $out
          $CXX -sASSERTIONS=1 -sWASMFS=1 --no-entry \
            --js-library=${wasmfsIdb.jsLibrary} -lwasmfs-idb \
            -sEXPORTED_RUNTIME_METHODS=$(cat $out/exported-runtime-methods.txt) \
            -sEXPORTED_FUNCTIONS=$(cat $out/exported-functions.txt) \
            --emit-tsd $out/emscripten.d.ts -o probe.js
          runHook postBuild
        '';
        dontInstall = true;
      };

      sources = lib.fileset.toSource {
        root = ./src;
        fileset = lib.fileset.unions [
          ./src/tsconfig.json
          ./src/libwasmfs_idb.js
          ./src/emscripten-library.d.ts
        ];
      };
    in
    {
      checks.wasmfs-idb-types =
        pkgs.runCommand "ibus-web-wasmfs-idb-types-check"
          {
            nativeBuildInputs = [
              typescript.nodejs
              typescript.tsc
            ];
          }
          ''
            node ${./library-deps.mjs} check ${sources}/libwasmfs_idb.js ${emscripten}/share/emscripten
            cp -r --no-preserve=mode ${sources} src
            ln -s ${types} src/${typesDir}
            tsc -p src
            touch $out
          '';

      devshells.default.devshell.startup.wasmfs-idb-types.text = ''
        ln -sfn ${types} "$FLAKE_ROOT/runtime/wasmfs-idb/src/${typesDir}"
      '';
    };
}
