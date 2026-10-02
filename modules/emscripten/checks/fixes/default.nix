# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) toolchain typescript;
      minimumFlags = toolchain.minimumVersionFlags;
      # WasmFS's internal headers, for a test of its backend threads.
      wasmfsInclude = "-I${toolchain.emscripten}/share/emscripten/system/lib/wasmfs";
    in
    {
      ibusWeb.toolchain.clangdPathFlags."modules/emscripten/checks/fixes/.*\\.cpp" = [ wasmfsInclude ];

      # The behaviour each of the toolchain's Emscripten fixes restores, on
      # the file system test programs run on (WasmFS under Node), for the
      # standard streams on the one GLib's tools run on (Node's own), and for
      # threads under a main thread that never returns to its event loop or
      # that loads a module while they run, for the Worker a destroyed WasmFS
      # backend thread leaves in the pool, and for a memory imported, without
      # growth, at a size between its initial size and its maximum.
      checks.emscripten-fixes =
        pkgs.runCommand "ibus-web-emscripten-fixes"
          {
            nativeBuildInputs = [
              toolchain.emscripten
              typescript.nodejs
              toolchain.emscriptenCacheHook
            ];
          }
          ''
            emcc ${toolchain.commonFlags} -O2 -c ${./fixes.c} -o fixes.o
            em++ ${toolchain.commonFlags} ${minimumFlags} ${toolchain.testMainFlags} fixes.o -o fixes.js
            mkdir host
            # A lock-order regression in the racing renames would hang.
            timeout 300 node fixes.js $PWD/host

            emcc ${toolchain.commonFlags} -O2 -c ${./fstat-stdio.c} -o fstat-stdio.o
            emcc ${toolchain.commonFlags} -O2 ${minimumFlags} -sASSERTIONS=1 -sNODERAWFS=1 -sEXIT_RUNTIME=1 \
              fstat-stdio.o -o fstat-stdio.js
            node fstat-stdio.js < /dev/null

            emcc ${toolchain.commonFlags} -O2 -c ${./thread-cleanup.c} -o thread-cleanup.o
            em++ ${toolchain.commonFlags} ${minimumFlags} ${toolchain.testMainFlags} thread-cleanup.o -o thread-cleanup.js
            timeout 120 node thread-cleanup.js

            emcc ${toolchain.commonFlags} ${minimumFlags} ${toolchain.sideModuleFlags} ${./dlsync-side.c} -o dlsync-side.wasm
            emcc ${toolchain.commonFlags} -O2 -c ${./dlsync-reused.c} -o dlsync-reused.o
            em++ ${toolchain.commonFlags} ${minimumFlags} ${toolchain.testMainFlags} dlsync-reused.o -o dlsync-reused.js
            timeout 120 node dlsync-reused.js $PWD/dlsync-side.wasm

            emcc ${toolchain.commonFlags} -O2 -c ${./dlsync-freed.c} -o dlsync-freed.o
            em++ ${toolchain.commonFlags} ${minimumFlags} ${toolchain.testMainFlags} dlsync-freed.o -o dlsync-freed.js
            timeout 120 node dlsync-freed.js $PWD/dlsync-side.wasm

            cp dlsync-side.wasm dlsync-side2.wasm
            emcc ${toolchain.commonFlags} -O2 -c ${./dlsync-held.c} -o dlsync-held.o
            em++ ${toolchain.commonFlags} ${minimumFlags} ${toolchain.testMainFlags} dlsync-held.o -o dlsync-held.js
            timeout 120 node dlsync-held.js $PWD/dlsync-side.wasm $PWD/dlsync-side2.wasm

            emcc ${toolchain.commonFlags} -O2 -c ${./dlsync-exit.c} -o dlsync-exit.o
            em++ ${toolchain.commonFlags} ${minimumFlags} ${toolchain.testMainFlags} dlsync-exit.o -o dlsync-exit.js
            status=0
            timeout 120 node dlsync-exit.js $PWD/dlsync-side.wasm || status=$?
            if [ $status -ne 42 ]; then
              echo "dlsync-exit: exit status $status, not the 42 it exit()ed with"
              exit 1
            fi

            em++ ${toolchain.commonFlags} -O2 ${wasmfsInclude} \
              -c ${./proxy-worker-exit.cpp} -o proxy-worker-exit.o
            em++ ${toolchain.commonFlags} ${minimumFlags} ${toolchain.testMainFlags} proxy-worker-exit.o -o proxy-worker-exit.js
            timeout 120 node proxy-worker-exit.js

            # Fails to link where MAXIMUM_MEMORY is ignored without growth,
            # which emcc warns about.
            emcc ${toolchain.commonFlags} -O2 -c ${./imported-memory-maximum.c} -o imported-memory-maximum.o
            emcc ${toolchain.commonFlags} -O2 ${minimumFlags} -sASSERTIONS=1 -Werror=unused-command-line-argument \
              -sALLOW_MEMORY_GROWTH=0 -sABORTING_MALLOC=0 -sIMPORTED_MEMORY=1 \
              -sINITIAL_MEMORY=16MB -sMAXIMUM_MEMORY=64MB -sPTHREAD_POOL_SIZE=1 -sEXIT_RUNTIME=1 \
              --pre-js=${./size-pre.js} \
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
