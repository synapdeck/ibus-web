# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) toolchain;
    in
    {
      # The behaviour each of the toolchain's Emscripten fixes restores, on
      # the file system test programs run on (WasmFS under Node), for the
      # standard streams on the one GLib's tools run on (Node's own), and for
      # threads under a main thread that never returns to its event loop or
      # that loads a module while they run.
      checks.emscripten-fixes =
        pkgs.runCommand "ibus-web-emscripten-fixes"
          {
            nativeBuildInputs = [
              toolchain.emscripten
              pkgs.nodejs
              toolchain.emscriptenCacheHook
            ];
          }
          ''
            emcc ${toolchain.commonFlags} -O2 -c ${./fixes.c} -o fixes.o
            em++ ${toolchain.commonFlags} ${toolchain.testMainFlags} fixes.o -o fixes.js
            mkdir host
            # A lock-order regression in the racing renames would hang.
            timeout 300 node fixes.js $PWD/host

            emcc ${toolchain.commonFlags} -O2 -c ${./fstat-stdio.c} -o fstat-stdio.o
            emcc ${toolchain.commonFlags} -O2 -sASSERTIONS=1 -sNODERAWFS=1 -sEXIT_RUNTIME=1 \
              fstat-stdio.o -o fstat-stdio.js
            node fstat-stdio.js < /dev/null

            emcc ${toolchain.commonFlags} -O2 -c ${./thread-cleanup.c} -o thread-cleanup.o
            em++ ${toolchain.commonFlags} ${toolchain.testMainFlags} thread-cleanup.o -o thread-cleanup.js
            timeout 120 node thread-cleanup.js

            emcc ${toolchain.commonFlags} ${toolchain.sideModuleFlags} ${./dlsync-side.c} -o dlsync-side.wasm
            emcc ${toolchain.commonFlags} -O2 -c ${./dlsync-reused.c} -o dlsync-reused.o
            em++ ${toolchain.commonFlags} ${toolchain.testMainFlags} dlsync-reused.o -o dlsync-reused.js
            timeout 120 node dlsync-reused.js $PWD/dlsync-side.wasm
            touch $out
          '';
    };
}
