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
      # that loads a module while they run, and for a memory imported, without
      # growth, at a size between its initial size and its maximum.
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

            emcc ${toolchain.commonFlags} -O2 -c ${./dlsync-freed.c} -o dlsync-freed.o
            em++ ${toolchain.commonFlags} ${toolchain.testMainFlags} dlsync-freed.o -o dlsync-freed.js
            timeout 120 node dlsync-freed.js $PWD/dlsync-side.wasm

            cp dlsync-side.wasm dlsync-side2.wasm
            emcc ${toolchain.commonFlags} -O2 -c ${./dlsync-held.c} -o dlsync-held.o
            em++ ${toolchain.commonFlags} ${toolchain.testMainFlags} dlsync-held.o -o dlsync-held.js
            timeout 120 node dlsync-held.js $PWD/dlsync-side.wasm $PWD/dlsync-side2.wasm

            emcc ${toolchain.commonFlags} -O2 -c ${./dlsync-exit.c} -o dlsync-exit.o
            em++ ${toolchain.commonFlags} ${toolchain.testMainFlags} dlsync-exit.o -o dlsync-exit.js
            status=0
            timeout 120 node dlsync-exit.js $PWD/dlsync-side.wasm || status=$?
            if [ $status -ne 42 ]; then
              echo "dlsync-exit: exit status $status, not the 42 it exit()ed with"
              exit 1
            fi

            # The memory's size comes from the command line, as its first
            # argument in MiB.
            echo 'if (!ENVIRONMENT_IS_PTHREAD) Module.INITIAL_MEMORY = Number(process.argv[2]) * 1024 * 1024;' > size.js
            # Fails to link where MAXIMUM_MEMORY is ignored without growth,
            # which emcc warns about.
            emcc ${toolchain.commonFlags} -O2 -c ${./imported-memory-maximum.c} -o imported-memory-maximum.o
            emcc ${toolchain.commonFlags} -O2 -sASSERTIONS=1 -Werror=unused-command-line-argument \
              -sALLOW_MEMORY_GROWTH=0 -sABORTING_MALLOC=0 -sIMPORTED_MEMORY=1 \
              -sINITIAL_MEMORY=16MB -sMAXIMUM_MEMORY=64MB -sPTHREAD_POOL_SIZE=1 -sEXIT_RUNTIME=1 \
              --pre-js=size.js \
              imported-memory-maximum.o -o imported-memory-maximum.js
            for mib in 16 48 64; do
              node imported-memory-maximum.js $mib
            done
            if node imported-memory-maximum.js 80 2> above.err; then
              echo "imported-memory-maximum: a memory above the maximum was taken"
              exit 1
            fi
            grep -q LinkError above.err || { cat above.err; exit 1; }
            touch $out
          '';
    };
}
