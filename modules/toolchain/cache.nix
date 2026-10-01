# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) toolchain;
      inherit (toolchain) emscripten;

      # -O2 over -Os: engine data, not code, dominates download size, and
      # keystrokes have a latency budget.
      commonFlags = "-O2 -fPIC -pthread -fwasm-exceptions";

      # Link settings the cache is prepared for. Emscripten picks library
      # variants from link settings, so tests must link with one of these.
      # Main modules always link with em++: they must carry the C++ runtime
      # for C++ side modules, and linking one with emcc leaves libunwind's
      # reference to __gxx_wasm_personality_v0 unresolved.
      mainLinkNode = "-sMAIN_MODULE=1 -sPTHREAD_POOL_SIZE=2 -sNODERAWFS=1 -sEXIT_RUNTIME=1";
      mainLinkWasmfs = "-sMAIN_MODULE=2 -sPTHREAD_POOL_SIZE=2 -sWASMFS=1 -sEXIT_RUNTIME=1";

      # Node-run programs on WasmFS, the runtime's file system. `object`
      # gives them the host's files at the host's paths.
      nodeHostFsFlags = object: "-sWASMFS=1 -sNODE_HOST_ENV=1 ${object}";
      mainLinkNodeWasmfs =
        object: "-sMAIN_MODULE=1 -sPTHREAD_POOL_SIZE=2 -sEXIT_RUNTIME=1 ${nodeHostFsFlags object}";

      # A fixed memory for Node-run tests: with pthreads, a memory that grows
      # has let threads fault out of bounds, and a test that outgrows a fixed
      # one fails plainly instead. GLib's largest test peaks at 280 MiB.
      testMemoryFlags = "-sALLOW_MEMORY_GROWTH=0 -sINITIAL_MEMORY=512MB";

      # Every dynamic link warns that Emscripten's dynamic linking with
      # pthreads (em++) and wasm-ld's PIC linking are experimental. These
      # flags acknowledge it; the linked output is the same without them.
      dynamicLinkFlags = "-Wno-experimental -Wl,--experimental-pic";

      emscriptenCache = pkgs.stdenvNoCC.mkDerivation {
        pname = "emscripten-cache";
        inherit (emscripten) version;
        src = ./probes;
        passthru = { inherit emscripten; };
        nativeBuildInputs = [
          emscripten
          pkgs.nodejs
        ];

        buildPhase = ''
          runHook preBuild
          export HOME=$TMPDIR
          export EM_CACHE=$TMPDIR/cache
          cp -r --no-preserve=mode ${emscripten}/share/emscripten/cache $EM_CACHE

          # The level comes last so it overrides the one in the common
          # flags: a package's own -O0 links against the debug variants.
          emcc ${commonFlags} -c ${./node-host-fs.c} -o $TMPDIR/node-host-fs.o
          for opt in -O0 -O2; do
            emcc ${commonFlags} $opt -c probe.c -o $TMPDIR/probe.o
            # Configure scripts link plain test executables with the
            # project's compile flags.
            emcc ${commonFlags} $opt $TMPDIR/probe.o -o $TMPDIR/probe-plain-c.js
            em++ ${commonFlags} $opt probe.cpp -o $TMPDIR/probe-plain-cpp.js
            # GLib's tests are plain executables on WasmFS.
            emcc ${commonFlags} $opt ${nodeHostFsFlags "$TMPDIR/node-host-fs.o"} ${testMemoryFlags} \
              $TMPDIR/probe.o -o $TMPDIR/probe-plain-wasmfs.js
            for link in "${mainLinkNode}" "${mainLinkWasmfs}" \
              "${mainLinkNodeWasmfs "$TMPDIR/node-host-fs.o"} ${testMemoryFlags}"; do
              em++ ${commonFlags} $opt $link $TMPDIR/probe.o -o $TMPDIR/probe-c.js
              em++ ${commonFlags} $opt $link probe.cpp -o $TMPDIR/probe-cpp.js
            done
            emcc ${commonFlags} $opt -sSIDE_MODULE=1 probe_side.c -o $TMPDIR/probe-side.wasm
            em++ ${commonFlags} $opt -sSIDE_MODULE=1 probe_side.cpp -o $TMPDIR/probe-side-cpp.wasm
          done

          node $TMPDIR/probe-c.js
          node $TMPDIR/probe-cpp.js
          node $TMPDIR/probe-plain-wasmfs.js
          runHook postBuild
        '';

        installPhase = ''
          runHook preInstall
          rm -rf $EM_CACHE/build
          cp -r $EM_CACHE $out
          runHook postInstall
        '';
      };

      nodeHostFs =
        pkgs.runCommand "ibus-web-node-host-fs"
          {
            nativeBuildInputs = [
              emscripten
              toolchain.emscriptenCacheHook
            ];
          }
          ''
            mkdir $out
            emcc ${commonFlags} -c ${./node-host-fs.c} -o $out/node-host-fs.o
          '';
    in
    {
      ibusWeb.toolchain = {
        inherit
          commonFlags
          dynamicLinkFlags
          emscriptenCache
          testMemoryFlags
          ;
        # Every link inherits the wrapper's -O2, which turns Emscripten's
        # runtime assertions off; test programs want them back.
        testMainFlags = "-O2 -sASSERTIONS=1 ${testMemoryFlags} ${mainLinkNodeWasmfs "${nodeHostFs}/node-host-fs.o"} ${dynamicLinkFlags}";
        sideModuleFlags = "-sSIDE_MODULE=1 ${dynamicLinkFlags}";
        nodeHostFsFlags = nodeHostFsFlags "${nodeHostFs}/node-host-fs.o";
        emscriptenCacheHook = pkgs.makeSetupHook {
          name = "emscripten-cache-hook";
          substitutions.cache = emscriptenCache;
        } ./emscripten-cache-hook.sh;
      };

      legacyPackages.emscriptenCache = emscriptenCache;

      # Probe programs must build from the cache alone, and a variant the cache
      # lacks must fail rather than be compiled.
      checks.toolchain-cache =
        pkgs.runCommand "ibus-web-toolchain-cache-check"
          {
            nativeBuildInputs = [
              emscripten
              pkgs.nodejs
              toolchain.emscriptenCacheHook
            ];
          }
          ''
            cp ${./probes}/* .
            emcc ${toolchain.commonFlags} -O2 -c probe.c -o probe.o
            em++ ${toolchain.commonFlags} ${toolchain.testMainFlags} probe.o -o probe-c.js
            em++ ${toolchain.commonFlags} ${toolchain.testMainFlags} probe.cpp -o probe-cpp.js
            test "$(node probe-c.js)" = "probe 7"
            test "$(node probe-cpp.js)" = "probe 2"
            em++ ${toolchain.commonFlags} -O2 ${mainLinkWasmfs} ${toolchain.dynamicLinkFlags} probe.o -o probe-wasmfs.js
            test "$(node probe-wasmfs.js)" = "probe 7"
            emcc ${toolchain.commonFlags} -O2 -sASSERTIONS=1 ${toolchain.nodeHostFsFlags} \
              ${toolchain.testMemoryFlags} probe.o -o probe-plain-wasmfs.js
            test "$(node probe-plain-wasmfs.js)" = "probe 7"

            emcc ${toolchain.commonFlags} probe.o -o probe-plain.js
            test "$(node probe-plain.js)" = "probe 7"
            em++ ${toolchain.commonFlags} probe.cpp -o probe-plain-cpp.js
            test "$(node probe-plain-cpp.js)" = "probe 2"

            if em++ ${toolchain.commonFlags} ${toolchain.testMainFlags} -sMALLOC=mimalloc probe.o -o uncached.js 2> uncached.log; then
              echo "expected an uncached library variant to fail" >&2
              exit 1
            fi
            grep -q "Permission denied" uncached.log
            touch $out
          '';
    };
}
