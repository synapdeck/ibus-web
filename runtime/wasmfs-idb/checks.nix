# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{
  perSystem =
    { config, lib, ... }:
    let
      inherit (config.ibusWeb) runtime testing;
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

      testLibraries = runtime.wasmfsIdbTestLibraries;
    in
    {
      ibusWeb.runtime.wasmfsIdbTestLibraries = [
        ./tests/chunk-counts.js
        ./tests/faults.js
        ./tests/strict-commits.js
      ];

      # The tests and their headers are C++ against GoogleTest; some reach
      # into WasmFS's internals.
      ibusWeb.toolchain.clangdPathFlags."runtime/wasmfs-idb/tests/.*\\.(cpp|h)" = [
        "-std=c++17"
        wasmfsIdb.cflags
      ]
      ++ testing.gtestCflagList;

      checks.wasmfs-idb = testing.programs {
        name = "wasmfs-idb";
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
    };
}
