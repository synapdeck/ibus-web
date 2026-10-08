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
      inherit (config.ibusWeb.lib) emscriptenRoot;
      inherit (config.ibusWeb) runtime testing typescript;
      inherit (config.ibusWeb.toolchain) pkgsWasm emscripten;
      inherit (runtime) wasmfsIdb;

      # The checker with its package's manifest, which makes it a module, and
      # the dependencies it imports.
      libraryDepsDir = pkgs.runCommand "ibus-web-library-deps" { } ''
        mkdir $out
        cp ${../../tools/emscripten-library-deps/library-deps.ts} $out/library-deps.ts
        cp ${../../tools/emscripten-library-deps/package.json} $out/package.json
        ln -s ${typescript.packageNodeModules ../../tools/emscripten-library-deps} $out/node_modules
      '';
      libraryDeps = "${libraryDepsDir}/library-deps.ts";

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
          node ${libraryDeps} emit ${wasmfsIdb.jsLibrary} ${emscriptenRoot} $out
          $CXX -sASSERTIONS=1 -sWASMFS=1 --no-entry \
            --js-library=${wasmfsIdb.jsLibrary} -lwasmfs-idb \
            -sEXPORTED_RUNTIME_METHODS=$(cat $out/exported-runtime-methods.txt) \
            -sEXPORTED_FUNCTIONS=$(cat $out/exported-functions.txt) \
            --emit-tsd $out/emscripten.d.ts -o probe.js
          runHook postBuild
        '';
        dontInstall = true;
      };

      # The sources at their places in the repository, so the configs'
      # extends of its base config resolve.
      root = ../..;
      sources = lib.fileset.toSource {
        inherit root;
        fileset = lib.fileset.unions (
          runtime.wasmfsIdbTestLibraries
          ++ [
            ./tsconfig.worker.json
            ./src/libwasmfs_idb.js
            ./src/emscripten-library.d.ts
            ./tsconfig.test.json
            ./tests/stderr-post.js
            ./tests/errors-post.js
            ./tests/wasm-exports.d.ts
            ./tests/post-js.d.ts
            ./tsconfig.library-types.json
            ./tests/library-types/rejected.js
          ]
        );
      };
      # Where a source is in a copy of the sources.
      sourcePath = path: lib.escapeShellArg (lib.path.removePrefix root path);
      here = sourcePath ./.;
    in
    {
      # The checker parses libraries with the workspace's acorn and Emscripten
      # with its own, and both must read a library alike.
      checks.wasmfs-idb-acorn =
        pkgs.runCommand "ibus-web-wasmfs-idb-acorn-check"
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

      checks.wasmfs-idb-types =
        pkgs.runCommand "ibus-web-wasmfs-idb-types-check"
          {
            nativeBuildInputs = [
              typescript.nodejs
              typescript.tsc
            ];
          }
          ''
            cp -r --no-preserve=mode ${sources} source
            cd source
            mkdir -p node_modules/@ibus-web
            cp -R ${typescript.presets} node_modules/@ibus-web/tsconfig
            node ${libraryDeps} check ${sourcePath ./src/libwasmfs_idb.js} ${emscriptenRoot}
            for library in ${lib.concatMapStringsSep " " sourcePath runtime.wasmfsIdbTestLibraries}; do
              node ${libraryDeps} check "$library" ${emscriptenRoot}
            done
            cd ${here}
            ln -s ${types} src/${typesDir}
            tsc -p tsconfig.worker.json
            tsc -p tsconfig.test.json

            # The library's own type must reject what Emscripten would: a
            # file of calls that each break one rule fails with one error
            # per call, each carrying the message written above the call.
            rejected=tests/library-types/rejected.js
            if tsc -p tsconfig.library-types.json > errors.txt; then
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

      # The checker itself, over small libraries and over Emscripten's tree
      # with its rules changed.
      checks.wasmfs-idb-library-deps = testing.programs {
        name = "wasmfs-idb-library-deps";
        environments = [ "node" ];
        programs = [ ];
        nodeTests = ../../tools/emscripten-library-deps;
        nodeTestData = {
          inherit libraryDeps;
          emscripten = "${emscriptenRoot}";
        };
      };

      ibusWeb.runtime = { inherit libraryDeps; };

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
