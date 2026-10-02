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
      inherit (config.ibusWeb) runtime typescript;
      inherit (config.ibusWeb.toolchain) pkgsWasm emscripten;
      inherit (runtime) wasmfsIdb;

      # Where the library's type check finds these types, beside its sources.
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
          node ${./library-deps.mjs} emit ${wasmfsIdb.jsLibrary} ${emscripten}/share/emscripten $out
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
        root = ./.;
        fileset = lib.fileset.unions (
          runtime.wasmfsIdbTestLibraries
          ++ [
            ./src/tsconfig.json
            ./src/libwasmfs_idb.js
            ./src/emscripten-library.d.ts
            ./tests/tsconfig.json
            ./tests/stderr-post.js
            ./tests/errors-post.js
            ./tests/wasm-exports.d.ts
            ./tests/post-js.d.ts
          ]
        );
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
            node ${./library-deps.mjs} check ${sources}/src/libwasmfs_idb.js ${emscripten}/share/emscripten
            for library in ${
              lib.concatMapStringsSep " " (
                library: "${sources}/tests/${baseNameOf library}"
              ) runtime.wasmfsIdbTestLibraries
            }; do
              node ${./library-deps.mjs} check "$library" ${emscripten}/share/emscripten
            done
            cp -r --no-preserve=mode ${sources}/src ${sources}/tests .
            ln -s ${types} src/${typesDir}
            tsc -p src
            tsc -p tests

            # The library's own type must reject what Emscripten would: a
            # file of calls that each break one rule fails with one error
            # per call, each carrying the message written above the call.
            rejected=${./tests/library-types/rejected.js}
            if tsc --noEmit --strict --allowJs --checkJs --target es2022 \
              --lib es2022 --module preserve --types "" \
              src/emscripten-library.d.ts "$rejected" > errors.txt; then
              echo "$rejected: type-checks, but every call in it is wrong" >&2
              exit 1
            fi
            expected=$(grep -c '^// error: ' "$rejected")
            if [ "$(grep -c 'error TS' errors.txt)" != "$expected" ]; then
              cat errors.txt >&2
              echo "$rejected: expected $expected errors" >&2
              exit 1
            fi
            sed -n 's|^// error: ||p' "$rejected" | while IFS= read -r message; do
              if ! grep -qF -- "$message" errors.txt; then
                cat errors.txt >&2
                echo "$rejected: no error says: $message" >&2
                exit 1
              fi
            done
            touch $out
          '';

      packages.wasmfs-idb-types = types;

      # Built when the shell starts rather than as part of it, so the shell
      # still enters while the library or the backend doesn't build. The
      # out-link keeps the types from garbage collection.
      devshells.default.devshell.startup.wasmfs-idb-types.text = ''
        rm -f "$FLAKE_ROOT/runtime/wasmfs-idb/src/${typesDir}"
        nix build "$FLAKE_ROOT#packages.${system}.wasmfs-idb-types" \
          --out-link "$FLAKE_ROOT/runtime/wasmfs-idb/src/${typesDir}" ||
          echo "wasmfs-idb types unavailable" >&2
      '';
    };
}
