# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{
  perSystem =
    { config, lib, ... }:
    let
      inherit (config.ibusWeb) toolchain runtime;
      inherit (toolchain) pkgsWasm emscripten;

      # The backend subclasses WasmFS's internal classes, whose virtuals the
      # project's Emscripten patches change, so it compiles against the
      # headers of the very tree the library cache was built from.
      cflags = "-I${emscripten}/share/emscripten/system/lib/wasmfs";

      wasmfsIdb = pkgsWasm.stdenv.mkDerivation (finalAttrs: {
        pname = "wasmfs-idb";
        # Part of the runtime, versioned with it.
        inherit (runtime.libibusWeb) version;
        src = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [
            ./include
            ./src
          ];
        };
        dontFixup = true;
        buildPhase = ''
          runHook preBuild
          $CXX -std=c++17 ${cflags} -Iinclude -c src/idb_backend.cpp -o idb_backend.o
          $AR rcs libwasmfs-idb.a idb_backend.o
          runHook postBuild
        '';
        installPhase = ''
          runHook preInstall
          install -Dm644 -t $out/lib libwasmfs-idb.a
          install -Dm644 -t $out/share/wasmfs-idb src/libwasmfs_idb.js
          install -Dm644 -t $out/include/ibus-web include/ibus-web/wasmfs-idb.h
          runHook postInstall
        '';
        passthru = {
          # Links that take the library pass this with --js-library.
          jsLibrary = "${finalAttrs.finalPackage}/share/wasmfs-idb/libwasmfs_idb.js";
          inherit cflags;
        };
      });
    in
    {
      ibusWeb.runtime.wasmfsIdb = wasmfsIdb;
      ibusWeb.toolchain.devLibraries = [ wasmfsIdb ];
      ibusWeb.toolchain.clangdPathFlags."runtime/wasmfs-idb/src/.*" = [
        "-std=c++17"
        cflags
      ];
      packages.wasmfs-idb = wasmfsIdb;
    };
}
