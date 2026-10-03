# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{
  perSystem =
    { config, lib, ... }:
    let
      inherit (config.ibusWeb) runtime testing;
      inherit (config.ibusWeb.toolchain) pkgsWasm;
      inherit (runtime) wasmfsIdb;
      tests = ./tests;

      # A directory holding one GoogleTest program, name.js and name.wasm,
      # from name.cpp; some reach into WasmFS's internals. The pool starts
      # with a thread for the tests and one for each backend their cases
      # create, since WasmFS keeps every backend, and its thread, for good;
      # past that, a thread starts only once the program's main thread is
      # back in its event loop. The test libraries add nothing to a program
      # that doesn't ask for them.
      program =
        {
          name,
          backends,
          postJs ? [ ],
        }:
        pkgsWasm.stdenv.mkDerivation {
          name = "ibus-web-wasmfs-idb-test-${name}";
          src = lib.fileset.toSource {
            root = tests;
            fileset = lib.fileset.unions [
              (tests + "/${name}.cpp")
              (lib.fileset.fileFilter (file: file.hasExt "h") tests)
            ];
          };
          buildInputs = [ wasmfsIdb ];
          dontFixup = true;
          buildPhase = ''
            runHook preBuild
            $CXX -std=c++17 ${testing.gtestMain.cflags} ${wasmfsIdb.cflags} -c ${name}.cpp -o ${name}.o
            $CXX ${testing.browserLinkFlags} -sWASMFS=1 -sPTHREAD_POOL_SIZE=${toString (backends + 1)} \
              --js-library=${wasmfsIdb.jsLibrary} \
              ${lib.concatMapStringsSep " " (library: "--js-library=${library}") testLibraries} \
              ${lib.concatMapStringsSep " " (file: "--post-js=${file}") postJs} \
              ${name}.o -lwasmfs-idb ${testing.gtestMain.libs} -o ${name}.js
            runHook postBuild
          '';
          installPhase = ''
            runHook preInstall
            install -Dm644 -t $out ${name}.js ${name}.wasm
            runHook postInstall
          '';
          passthru.testProgram = {
            inherit name;
            format = "gtest-json";
          };
        };

      testLibraries = runtime.wasmfsIdbTestLibraries;
    in
    {
      ibusWeb.runtime.wasmfsIdbTestLibraries = [
        ./tests/chunk-counts.js
        ./tests/faults.js
        ./tests/strict-commits.js
      ];

      # The tests' headers are C++ against GoogleTest.
      ibusWeb.toolchain.clangdPathFlags."runtime/wasmfs-idb/tests/.*\\.(cpp|h)" =
        lib.splitString " " testing.gtestMain.cflags;

      checks.wasmfs-idb = testing.programs {
        name = "wasmfs-idb";
        environments = [
          "chromium"
          "firefox"
        ];
        programs = map program [
          {
            name = "basic.1";
            backends = 1;
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
          {
            name = "sweep.1";
            backends = 1;
          }
          # The first writer, a read-only backend, the writer whose sweep
          # fails and the last writer.
          {
            name = "sweep.2";
            backends = 4;
            postJs = [ ./tests/stderr-post.js ];
          }
        ];
      };
    };
}
