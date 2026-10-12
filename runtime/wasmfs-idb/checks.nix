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
      inherit (config.ibusWeb.lib) emscriptenRoot;
      inherit (config.ibusWeb) runtime testing typescript;
      inherit (runtime) wasmfsIdb;
      tests = ./tests;

      # A directory holding one GoogleTest program, name.js and name.wasm,
      # from name.cpp; some reach into WasmFS's internals. The pool holds a
      # thread for the tests and one for each backend their cases create,
      # since WasmFS keeps every backend, and its thread, for good; creating
      # a thread past it fails, so a count that falls short fails the case
      # that needed one rather than slowing the program down. The test
      # libraries add nothing to a program that doesn't ask for them.
      program =
        {
          name,
          backends,
          postJs ? [ ],
        }:
        testing.program {
          inherit name;
          derivationName = "ibus-web-wasmfs-idb-test-${name}";
          src = tests;
          buildInputs = [ wasmfsIdb ];
          cflags = "-std=c++17 ${wasmfsIdb.cflags}";
          linkFlags = [
            testing.browserLinkFlags
            "-sWASMFS=1"
            "-sPTHREAD_POOL_SIZE=${toString (backends + 1)}"
            "-sPTHREAD_POOL_SIZE_STRICT=2"
            "--js-library=${wasmfsIdb.jsLibrary}"
          ]
          ++ map (library: "--js-library=${library}") testLibraries
          ++ map (file: "--post-js=${file}") postJs;
          libs = "-lwasmfs-idb";
        };

      # The JavaScript libraries the test programs link besides the backend's
      # own; each one's __deps are checked and it is type-checked.
      testLibraries = [
        ./tests/chunk-counts.js
        ./tests/faults.js
        ./tests/strict-commits.js
      ];

      # The sources at their places in the repository, so the configs'
      # extends of its base config resolve.
      root = ../..;
      sources = lib.fileset.toSource {
        inherit root;
        fileset = lib.fileset.unions (
          testLibraries
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
      # The tests and their headers are C++ against GoogleTest; some reach
      # into WasmFS's internals.
      ibusWeb.toolchain.clangdPathFlags."runtime/wasmfs-idb/tests/.*\\.(cpp|h)" = [
        "-std=c++17"
        "-I../include"
        wasmfsIdb.cflags
      ]
      ++ testing.gtestCflagList;

      checks.wasmfs-idb-browser = testing.programs {
        name = "wasmfs-idb-browser";
        environments = [
          "chromium"
          "firefox"
        ];
        programs = map program [
          {
            name = "basic.1";
            backends = 2;
          }
          {
            name = "basic.2";
            backends = 1;
          }
          {
            name = "open-unlinked";
            backends = 3;
          }
          {
            name = "lazy";
            backends = 8;
          }
          {
            name = "sizes";
            backends = 6;
          }
          # A read-only backend beside one case's own.
          {
            name = "fsync";
            backends = 6;
          }
          # Two backends for each of five cases, one for each of the other
          # seven, and one more for each of the two that open a fresh
          # database after one that fails to open, whose thread has ended by
          # then.
          {
            name = "errors";
            backends = 19;
            postJs = [
              ./tests/stderr-post.js
              ./tests/errors-post.js
            ];
          }
          {
            name = "seal";
            backends = 5;
          }
          # The fixture's backend and a reader beside it, for each of two
          # cases.
          {
            name = "visibility";
            backends = 4;
          }
          {
            name = "sweep.1";
            backends = 1;
          }
          # One for the database sweep.1 left, one for each fresh case's,
          # and the read-only backend, the writers whose sweeps fail and the
          # writer after one.
          {
            name = "sweep.2";
            backends = 9;
            postJs = [ ./tests/stderr-post.js ];
          }
        ];
      };

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
            node ${config.ibusWeb.lib.libraryDeps} check ${sourcePath ./src/libwasmfs_idb.js} ${emscriptenRoot}
            for library in ${lib.concatMapStringsSep " " sourcePath testLibraries}; do
              node ${config.ibusWeb.lib.libraryDeps} check "$library" ${emscriptenRoot}
            done
            cd ${here}
            ln -s ${config.ibusWeb.toolchain.emscriptenTypes.wasmfs-idb-types.package} src/emscripten-types
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
    };
}
