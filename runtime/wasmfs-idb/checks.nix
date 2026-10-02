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

      # A directory holding one test program, name.js and name.wasm, from
      # name.c or name.cpp; C++ tests reach into WasmFS's internals. Each
      # backend's own thread comes from the pool, which the program's main
      # thread can't grow while it blocks on the backend, so a program that
      # creates several backends asks for as many threads. The test
      # libraries add nothing to a program that doesn't ask for them.
      program =
        {
          source,
          threads ? 1,
          postJs ? null,
        }:
        let
          cxx = lib.hasSuffix ".cpp" source;
          name = lib.removeSuffix (if cxx then ".cpp" else ".c") source;
        in
        pkgsWasm.stdenv.mkDerivation {
          name = "ibus-web-wasmfs-idb-test-${name}";
          src = lib.fileset.toSource {
            root = tests;
            fileset = lib.fileset.unions [
              (tests + "/${source}")
              (lib.fileset.fileFilter (file: file.hasExt "h") tests)
            ];
          };
          buildInputs = [ wasmfsIdb ];
          dontFixup = true;
          buildPhase = ''
            runHook preBuild
            ${if cxx then "$CXX -std=c++17 ${wasmfsIdb.cflags}" else "$CC"} -c ${source} -o ${name}.o
            $CXX ${testing.browserLinkFlags} -sWASMFS=1 -sPTHREAD_POOL_SIZE=${toString threads} \
              --js-library=${wasmfsIdb.jsLibrary} \
              ${lib.concatMapStringsSep " " (library: "--js-library=${library}") testLibraries} \
              ${lib.optionalString (postJs != null) "--post-js=${postJs}"} \
              ${name}.o -lwasmfs-idb -o ${name}.js
            runHook postBuild
          '';
          installPhase = ''
            runHook preInstall
            install -Dm644 -t $out ${name}.js ${name}.wasm
            runHook postInstall
          '';
        };

      testLibraries = [
        ./tests/chunk-counts.js
        ./tests/faults.js
        ./tests/strict-commits.js
      ];
    in
    {
      checks.wasmfs-idb = testing.browserRun {
        name = "wasmfs-idb";
        programs = map program [
          { source = "basic.1.c"; }
          { source = "basic.2.c"; }
          { source = "open-unlinked.cpp"; }
          { source = "lazy.c"; }
          { source = "sizes.c"; }
          # The writer and a read-only backend.
          {
            source = "fsync.c";
            threads = 2;
          }
          # The writer, a read-only backend, and one more for each backend
          # that fails to open, then for one that opens.
          {
            source = "errors.c";
            threads = 3;
            postJs = ./tests/errors-post.js;
          }
          { source = "sweep.1.c"; }
          # The first writer, a read-only backend and the second writer.
          {
            source = "sweep.2.c";
            threads = 3;
          }
        ];
      };
    };
}
