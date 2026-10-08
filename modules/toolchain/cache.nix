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
      inherit (config.ibusWeb) toolchain runtime typescript;
      inherit (toolchain) emscripten;

      # -O2 over -Os: engine data, not code, dominates download size, and
      # keystrokes have a latency budget. When every target has
      # extended-const, emcc tells wasm-ld and wasm-opt but not clang, so
      # objects name it themselves, and every stage may use it.
      commonFlagList = [
        "-O2"
        "-fPIC"
        "-pthread"
        "-fwasm-exceptions"
        "-mextended-const"
      ];
      commonFlags = lib.concatStringsSep " " commonFlagList;

      # The feature probe leaves out -mextended-const so that the minimum
      # versions alone decide whether extended-const is on.
      probeFlags = lib.concatStringsSep " " (lib.remove "-mextended-const" commonFlagList);

      # Every probe link targets the browsers and Node that builds do.
      minimumFlags = toolchain.minimumVersionFlags;

      # Link settings the cache is prepared for. Emscripten picks library
      # variants from link settings, so tests must link with one of these.
      # Main modules always link with em++: they must carry the C++ runtime
      # for C++ side modules, and linking one with emcc leaves libunwind's
      # reference to __gxx_wasm_personality_v0 unresolved.
      mainLinkNode = "-sMAIN_MODULE=1 -sPTHREAD_POOL_SIZE=2 -sNODERAWFS=1 -sEXIT_RUNTIME=1";
      mainLinkWasmfs = "-sMAIN_MODULE=2 -sPTHREAD_POOL_SIZE=2 -sWASMFS=1 -sEXIT_RUNTIME=1";

      # The settings of the runtime's main-module link that pick library
      # variants: the runtime never exits, which takes a library of its own.
      runtimeMainFlags = "-sMAIN_MODULE=2 -sWASMFS=1 -sEXIT_RUNTIME=0 ${dynamicLinkFlags}";

      # Node-run programs on WasmFS, the runtime's file system. `object`
      # gives them the host's files at the host's paths.
      nodeHostFsFlagList = object: [
        "-sWASMFS=1"
        "-sNODE_HOST_ENV=1"
        object
      ];
      nodeHostFsFlags = object: lib.concatStringsSep " " (nodeHostFsFlagList object);
      mainLinkNodeWasmfs =
        object: "-sMAIN_MODULE=1 -sPTHREAD_POOL_SIZE=2 -sEXIT_RUNTIME=1 ${nodeHostFsFlags object}";

      # GoogleTest programs run main() on a pthread, which takes a startup
      # object of its own, in a PIC and a non-PIC build.
      proxyMainFlags = "-sPROXY_TO_PTHREAD=1 -sEXIT_RUNTIME=1";

      # A fixed memory for Node-run tests: with pthreads, a memory that grows
      # has let threads fault out of bounds, and a test that outgrows a fixed
      # one fails plainly instead. GLib's largest test peaks at 280 MiB.
      testMemoryFlagList = [
        "-sALLOW_MEMORY_GROWTH=0"
        "-sINITIAL_MEMORY=512MB"
      ];
      testMemoryFlags = lib.concatStringsSep " " testMemoryFlagList;

      # Every dynamic link warns that Emscripten's dynamic linking with
      # pthreads (em++) and wasm-ld's PIC linking are experimental. These
      # flags acknowledge it; the linked output is the same without them.
      dynamicLinkFlagList = [
        "-Wno-experimental"
        "-Wl,--experimental-pic"
      ];
      dynamicLinkFlags = lib.concatStringsSep " " dynamicLinkFlagList;
      sideModuleFlags = "-sSIDE_MODULE=1 ${dynamicLinkFlags}";

      emscriptenCache = pkgs.stdenvNoCC.mkDerivation {
        pname = "emscripten-cache";
        inherit (emscripten) version;
        src = ./probes;
        passthru = { inherit emscripten; };
        nativeBuildInputs = [
          emscripten
          typescript.nodejs
        ];

        buildPhase = ''
          runHook preBuild
          export HOME=$TMPDIR
          export EM_CACHE=$TMPDIR/cache
          cp -r --no-preserve=mode ${config.ibusWeb.lib.emscriptenRoot}/cache $EM_CACHE

          # The level comes last so it overrides the one in the common
          # flags: a package's own -O0 links against the debug variants.
          emcc ${commonFlags} -c ${./node-host-fs.c} -o $TMPDIR/node-host-fs.o
          for opt in -O0 -O2; do
            emcc ${commonFlags} $opt -c probe.c -o $TMPDIR/probe.o
            # Configure scripts link plain test executables with the
            # project's compile flags.
            emcc ${commonFlags} $opt ${minimumFlags} $TMPDIR/probe.o -o $TMPDIR/probe-plain-c.js
            em++ ${commonFlags} $opt ${minimumFlags} probe.cpp -o $TMPDIR/probe-plain-cpp.js
            # GLib's tests are plain executables on WasmFS.
            emcc ${commonFlags} $opt ${minimumFlags} ${nodeHostFsFlags "$TMPDIR/node-host-fs.o"} ${testMemoryFlags} \
              $TMPDIR/probe.o -o $TMPDIR/probe-plain-wasmfs.js
            for link in "${mainLinkNode}" "${mainLinkWasmfs}" \
              "${mainLinkNodeWasmfs "$TMPDIR/node-host-fs.o"} ${testMemoryFlags}"; do
              em++ ${commonFlags} $opt ${minimumFlags} $link ${dynamicLinkFlags} $TMPDIR/probe.o -o $TMPDIR/probe-c.js
              em++ ${commonFlags} $opt ${minimumFlags} $link ${dynamicLinkFlags} probe.cpp -o $TMPDIR/probe-cpp.js
            done
            # The runtime, released and asserting.
            for assertions in 0 1; do
              em++ ${commonFlags} $opt ${minimumFlags} ${runtimeMainFlags} -sASSERTIONS=$assertions \
                $TMPDIR/probe.o -o $TMPDIR/probe-runtime-c.js
              em++ ${commonFlags} $opt ${minimumFlags} ${runtimeMainFlags} -sASSERTIONS=$assertions \
                probe.cpp -o $TMPDIR/probe-runtime-cpp.js
            done
            em++ ${commonFlags} $opt ${minimumFlags} ${proxyMainFlags} probe.cpp -o $TMPDIR/probe-proxy.js
            em++ ${commonFlags} $opt ${minimumFlags} ${mainLinkNodeWasmfs "$TMPDIR/node-host-fs.o"} \
              ${testMemoryFlags} ${dynamicLinkFlags} ${proxyMainFlags} probe.cpp -o $TMPDIR/probe-proxy-main.js
            emcc ${commonFlags} $opt ${minimumFlags} ${sideModuleFlags} probe_side.c -o $TMPDIR/probe-side.wasm
            em++ ${commonFlags} $opt ${minimumFlags} ${sideModuleFlags} probe_side.cpp -o $TMPDIR/probe-side-cpp.wasm
          done

          node $TMPDIR/probe-c.js
          node $TMPDIR/probe-cpp.js
          node $TMPDIR/probe-plain-wasmfs.js
          node $TMPDIR/probe-proxy-main.js
          runHook postBuild
        '';

        installPhase = ''
          runHook preInstall
          rm -rf $EM_CACHE/build
          cp -r $EM_CACHE $out
          runHook postInstall
        '';
      };

      # Every link inherits the wrapper's -O2, which turns Emscripten's
      # runtime assertions off; test programs want them back.
      testMainFlagList = [
        "-O2"
        "-sASSERTIONS=1"
      ]
      ++ testMemoryFlagList
      ++ [
        "-sMAIN_MODULE=1"
        "-sPTHREAD_POOL_SIZE=2"
        "-sEXIT_RUNTIME=1"
      ]
      ++ nodeHostFsFlagList "${nodeHostFs}/node-host-fs.o"
      ++ dynamicLinkFlagList;

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
          runtimeMainFlags
          sideModuleFlags
          testMemoryFlags
          ;
        inherit testMainFlagList;
        testMainFlags = lib.concatStringsSep " " testMainFlagList;
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
              typescript.nodejs
              toolchain.emscriptenCacheHook
            ];
          }
          ''
            cp ${./probes}/* .
            emcc ${toolchain.commonFlags} -O2 -c probe.c -o probe.o
            em++ ${toolchain.commonFlags} ${minimumFlags} ${toolchain.testMainFlags} probe.o -o probe-c.js
            em++ ${toolchain.commonFlags} ${minimumFlags} ${toolchain.testMainFlags} probe.cpp -o probe-cpp.js
            test "$(node probe-c.js)" = "probe 7"
            test "$(node probe-cpp.js)" = "probe 2"
            em++ ${toolchain.commonFlags} -O2 ${minimumFlags} ${mainLinkWasmfs} ${toolchain.dynamicLinkFlags} probe.o -o probe-wasmfs.js
            test "$(node probe-wasmfs.js)" = "probe 7"
            emcc ${toolchain.commonFlags} -O2 ${minimumFlags} -sASSERTIONS=1 ${toolchain.nodeHostFsFlags} \
              ${toolchain.testMemoryFlags} probe.o -o probe-plain-wasmfs.js
            test "$(node probe-plain-wasmfs.js)" = "probe 7"

            em++ ${toolchain.commonFlags} ${minimumFlags} -sASSERTIONS=1 ${toolchain.nodeHostFsFlags} \
              ${toolchain.testMemoryFlags} ${proxyMainFlags} probe.cpp -o probe-proxy.js
            test "$(node probe-proxy.js)" = "probe 2"
            em++ ${toolchain.commonFlags} ${minimumFlags} ${toolchain.testMainFlags} ${proxyMainFlags} \
              probe.cpp -o probe-proxy-main.js
            test "$(node probe-proxy-main.js)" = "probe 2"

            emcc ${toolchain.commonFlags} ${minimumFlags} probe.o -o probe-plain.js
            test "$(node probe-plain.js)" = "probe 7"
            em++ ${toolchain.commonFlags} ${minimumFlags} probe.cpp -o probe-plain-cpp.js
            test "$(node probe-plain-cpp.js)" = "probe 2"

            # The runtime's link settings, released and asserting, with the
            # memory a host must make for it.
            # A file, not node -e: the pool's Workers inherit Node's flags.
            pages=$(( ${toString runtime.memory.minimum} / 65536 ))
            for assertions in 0 1; do
              em++ ${toolchain.commonFlags} ${minimumFlags} ${runtime.linkFlags} -sASSERTIONS=$assertions \
                probe.o -o probe-runtime.js
              test "$(node ${../../tools/toolchain-probes/instantiate.ts} $pages ./probe-runtime.js)" = "probe 7"
              em++ ${toolchain.commonFlags} ${minimumFlags} ${runtime.linkFlags} -sASSERTIONS=$assertions \
                probe.cpp -o probe-runtime-cpp.js
              test "$(node ${../../tools/toolchain-probes/instantiate.ts} $pages ./probe-runtime-cpp.js)" = "probe 2"
            done

            # What the minimum versions alone switch on, with nothing forcing
            # a feature: a main module and a side module, each compiled and
            # linked in one invocation so clang's features are listed too.
            # EMCC_DEBUG keeps the settings dump and the feature-matrix log.
            probe_features() {
              local name=$1; shift
              mkdir -p "dbg-$name"
              EMCC_DEBUG=1 EMCC_DEBUG_SAVE=1 EMCC_TEMP_DIR=$PWD/dbg-$name "$@" -v 2> "$name.log"
              local settings
              settings=$(find "dbg-$name" -name 'emcc-*-settings.json' | sort | tail -n 1)
              echo "== $name"
              node ${../../tools/toolchain-probes/probe-features.ts} "$name.log" $settings
            }
            {
              probe_features main em++ ${probeFlags} ${minimumFlags} ${runtime.linkFlags} probe.cpp -o features-main.js
              probe_features side emcc ${probeFlags} ${minimumFlags} ${toolchain.sideModuleFlags} probe_side.c -o features-side.wasm
            } > features.txt
            if ! diff -u ${./expected-features.txt} features.txt; then
              echo "The WebAssembly features the minimum versions enable have changed." >&2
              echo "Review the diff and, if it is intended, update expected-features.txt." >&2
              exit 1
            fi

            if em++ ${toolchain.commonFlags} ${minimumFlags} ${toolchain.testMainFlags} -sMALLOC=mimalloc probe.o -o uncached.js 2> uncached.log; then
              echo "expected an uncached library variant to fail" >&2
              exit 1
            fi
            grep -q "Permission denied" uncached.log
            touch $out
          '';
    };
}
