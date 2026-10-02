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

      # A directory holding one test program, name.js and name.wasm. The
      # backend's own thread comes from the pool, which the program's main
      # thread can't grow while it blocks on the backend.
      program =
        name:
        pkgsWasm.stdenv.mkDerivation {
          name = "ibus-web-wasmfs-idb-test-${name}";
          src = lib.fileset.toSource {
            root = tests;
            fileset = lib.fileset.unions [
              (tests + "/${name}.c")
              (lib.fileset.fileFilter (file: file.hasExt "h") tests)
            ];
          };
          buildInputs = [ wasmfsIdb ];
          dontFixup = true;
          buildPhase = ''
            runHook preBuild
            $CC -c ${name}.c -o ${name}.o
            $CXX ${testing.browserLinkFlags} -sWASMFS=1 -sPTHREAD_POOL_SIZE=1 \
              --js-library=${wasmfsIdb.jsLibrary} ${name}.o -lwasmfs-idb -o ${name}.js
            runHook postBuild
          '';
          installPhase = ''
            runHook preInstall
            install -Dm644 -t $out ${name}.js ${name}.wasm
            runHook postInstall
          '';
        };
    in
    {
      checks.wasmfs-idb = testing.browserRun {
        name = "wasmfs-idb";
        programs = map program [
          "basic.1"
          "basic.2"
        ];
      };
    };
}
