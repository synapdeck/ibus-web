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
      inherit (config.ibusWeb) runtime toolchain typescript;
      inherit (config.ibusWeb.testing) playwright;
      inherit (config.checks.runtime-spike-node.passthru) constants sidesDir;
      dist = "${typescript.workspace}/tests/spikes/runtime/dist";

      # GLib's 1bit-emufutex test, the one whose pthreads faulted out of
      # bounds now and then under memory growth: a hundred threads taking
      # GLib's bit locks through its emulated futex, each starting with
      # g_rand_new(). Built from the GLib tests' own build with the tests'
      # fixed memory swapped for memoryFlags, and only this test linked.
      emufutex =
        { name, memoryFlags }:
        config.checks.glib-tests.overrideAttrs (old: {
          pname = "ibus-web-glib-emufutex-${name}";
          mesonFlags =
            assert lib.count (lib.hasInfix toolchain.testMemoryFlags) old.mesonFlags == 2;
            map (lib.replaceStrings [ toolchain.testMemoryFlags ] [ memoryFlags ]) old.mesonFlags;
          buildPhase = ''
            runHook preBuild
            ninja -j$NIX_BUILD_CORES glib/tests/1bit-emufutex.js
            runHook postBuild
          '';
          installPhase = ''
            runHook preInstall
            mkdir -p $out
            cp glib/tests/1bit-emufutex.js glib/tests/1bit-emufutex.wasm $out/
            runHook postInstall
          '';
        });

      emufutexBuilds = {
        # Growth as the runtime would have been linked for it; Node has no
        # growable shared buffers, so its threads poll for a grown memory.
        growth = emufutex {
          name = "growth";
          memoryFlags = "-sALLOW_MEMORY_GROWTH=1 -sGROWABLE_ARRAYBUFFERS=1";
        };
        # The same, with function names, to run by hand for where a thread
        # faults.
        growthNamed = emufutex {
          name = "growth-named";
          memoryFlags = "-sALLOW_MEMORY_GROWTH=1 -sGROWABLE_ARRAYBUFFERS=1 --profiling-funcs";
        };
        # Just above the test's peak (96 MiB runs out), so a stray access
        # past the memory a grown heap would end at still faults.
        fixed = emufutex {
          name = "fixed";
          memoryFlags = "-sALLOW_MEMORY_GROWTH=0 -sINITIAL_MEMORY=104MB";
        };
      };

      # Shared memory grown on one thread and loaded on others, without
      # GLib or Emscripten's allocator.
      growrace = pkgs.stdenvNoCC.mkDerivation {
        name = "ibus-web-memory-growrace";
        src = ../../../tests/spikes/memory;
        nativeBuildInputs = [
          toolchain.emscripten
          toolchain.emscriptenCacheHook
        ];
        buildPhase = ''
          runHook preBuild
          flags="${toolchain.commonFlags} -sALLOW_MEMORY_GROWTH=1 -sGROWABLE_ARRAYBUFFERS=1 -sMAXIMUM_MEMORY=2GB -sEXIT_RUNTIME=1"
          emcc $flags -sPTHREAD_POOL_SIZE=64 -sENVIRONMENT=node growrace.c -o growrace.js
          runHook postBuild
        '';
        installPhase = ''
          runHook preInstall
          install -Dm644 growrace.js growrace.wasm -t $out
          runHook postInstall
        '';
      };

      # The repro without Emscripten, as its files.
      memoryDir = lib.fileset.toSource {
        root = ../../../tests/spikes/memory;
        fileset = lib.fileset.fileFilter (
          file: file.hasExt "mjs" || file.hasExt "html"
        ) ../../../tests/spikes/memory;
      };

      # The memory workloads' threads, as many as GLib's test starts, all
      # alive at once on a pool that holds them and leaves the spare Workers
      # idle, so the host never tops it up during a run.
      stressThreads = 100;
      stressPool = stressThreads + runtime.threadPool.lowWater;

      # The runtime as linked, with the pool the workloads need, and builds
      # of it that grow their memory, differing in how a memory that grows
      # reaches JavaScript.
      stressLink =
        name: flags:
        runtime.link {
          pname = "ibus-runtime-memory-${name}";
          extraFlags = "-sPTHREAD_POOL_SIZE=${toString stressPool} ${flags}";
        };
      MiB = 1024 * 1024;
      # Where the heap's break peaked under mem-stress, which depends on how
      # many of its threads hold their blocks at once: 173 MiB in 40 Node
      # runs, 165 MiB in 30 Chromium runs, 248 MiB in 30 Firefox runs;
      # under glib-stress, 104 MiB everywhere. A quarter more than the most,
      # as an engine's manifest would size it, rounded up.
      fixedMemory = 320 * MiB;
      links = {
        fixed = stressLink "fixed" "";
        # Growable shared buffers where they work, Emscripten's polling of
        # its views elsewhere.
        growth = stressLink "growth" "-sALLOW_MEMORY_GROWTH=1 -sGROWABLE_ARRAYBUFFERS=1";
        # Growable shared buffers or nothing.
        growable = stressLink "growable" "-sALLOW_MEMORY_GROWTH=1 -sGROWABLE_ARRAYBUFFERS=2";
      };
      # How each variant's host makes the memory: fixed at fixedMemory, or
      # from the runtime's least memory up to its most.
      variant =
        name: link: grows:
        let
          initial = if grows then runtime.memory.minimum else fixedMemory;
          maximum = if grows then runtime.memory.maximum else fixedMemory;
        in
        "--variant ${name}=${link}/ibus-runtime.js,${toString initial},${toString maximum}";
      variants = {
        fixed = variant "fixed" links.fixed false;
        growth = variant "growth" links.growth true;
        growable = variant "growable" links.growable true;
      };

      memoryArgs = lib.concatStringsSep " " [
        "--sides ${sidesDir}"
        "--errno ${runtime.nodeHarness}/errno.json"
        "--constants ${constants}/constants.json"
        "--pool ${toString stressPool}"
        "--planned-threads ${toString runtime.threadPool.planned}"
        "--engine-threads ${toString runtime.threadPool.shares.engine}"
        "--glib-threads ${toString runtime.threadPool.shares.glib}"
        "--pool-low-water ${toString runtime.threadPool.lowWater}"
        "--threads ${toString stressThreads}"
      ];

      # GLib's test, runs times, parallel at a time, each in a directory of
      # its own; prints the runs, the failures and each trapping thread's
      # innermost frames, by count.
      runEmufutex = pkgs.writeShellApplication {
        name = "run-emufutex";
        runtimeInputs = [
          typescript.nodejs
          pkgs.coreutils
          pkgs.findutils
          pkgs.gnugrep
        ];
        text = ''
          js=$1 runs=$2 parallel=$3
          out=$(mktemp -d)
          # The inner shell expands its own arguments.
          # shellcheck disable=SC2016
          seq "$runs" | xargs -P "$parallel" -I{} sh -c \
            'cd "$(mktemp -d)" && node "$0" > "$1/{}.out" 2> "$1/{}.err"; echo $? > "$1/{}.status"' "$js" "$out"
          # grep fails when it lists no file, which is the result hoped for.
          failed=$({ grep -L '^0$' "$out"/*.status || true; } | wc -l)
          trapped=$({ grep -l 'RuntimeError' "$out"/*.err || true; } | wc -l)
          echo "$runs runs, $failed failed, $trapped with a thread trapping"
          { grep -l 'RuntimeError' "$out"/*.err || true; } | while read -r err; do
            grep -m1 -A4 '^RuntimeError' "$err" | grep -o 'at [^ ]*' | head -4 | paste -sd ' '
          done | sort | uniq -c
          rm -r "$out"
        '';
      };
    in
    {
      legacyPackages.spikes.memory = {
        emufutex = emufutexBuilds;
        inherit growrace links;
      };

      # The rule the runtime's link follows, a memory the host makes and
      # that never grows, under both workloads: a few runs of each under
      # Node and in each browser, which must all pass, with the costs and
      # what a pool Worker costs. A run's pool of Workers each hold an
      # instance of the runtime, some 40 MiB under Node, so runs go one at
      # a time.
      checks.runtime-spike-memory =
        pkgs.runCommand "ibus-web-runtime-spike-memory"
          (
            {
              nativeBuildInputs = [ typescript.nodejs ];
            }
            // playwright.env
          )
          ''
            ${playwright.setup}
            echo "# Node" > $out
            ${runtime.nodeTimeout} node ${dist}/node/memory.js ${memoryArgs} ${variants.fixed} \
              --runs 3 --parallel 1 --costs --worker-memory >> $out || { cat $out; exit 1; }
            echo "# browsers" >> $out
            timeout --kill-after=10 900 node ${dist}/node/browser-memory.js ${memoryArgs} \
              ${variants.fixed} --runs 2 --parallel 1 >> $out || { cat $out; exit 1; }
            cat $out
          '';

      # The memory spike, run from a checkout: growrace without Emscripten's
      # runtime under Node, Bun and in the browsers; the C growrace under Node;
      # GLib's 1bit-emufutex test, growing and fixed, under Node; then the
      # runtime's memory workloads under Node and in the browsers, growing
      # and fixed, with what each costs and what a pool Worker costs. Parts
      # to run can be named (growrace, emufutex, node, browsers); the
      # environment sets the counts: RUNS (Node, 300), BROWSER_RUNS (50),
      # PARALLEL (Node runs at once, 6), EMUFUTEX_PARALLEL (32) and
      # GROWRACE_RUNS (races per growrace configuration, 20).
      apps.runtime-spike-memory = {
        type = "app";
        meta.description = "The memory spike: growth against fixed memory under many threads, in Node, Chromium and Firefox";
        program = lib.getExe (
          pkgs.writeShellApplication {
            name = "runtime-spike-memory";
            # Bun runs growrace on a second engine; nothing else uses it.
            runtimeInputs = [
              typescript.nodejs
              pkgs.bun
            ];
            text = ''
              ${lib.toShellVars playwright.env}
              export ${lib.concatStringsSep " " (lib.attrNames playwright.env)}
              declare -A emufutex=(
                [growth]=${emufutexBuilds.growth}/1bit-emufutex.js
                [fixed]=${emufutexBuilds.fixed}/1bit-emufutex.js
              )
              runs=''${RUNS:-300}
              browser_runs=''${BROWSER_RUNS:-50}
              parallel=''${PARALLEL:-6}
              growrace_runs=''${GROWRACE_RUNS:-20}
              parts=("$@")
              [ ''${#parts[@]} -gt 0 ] || parts=(growrace emufutex node browsers)
              status=0
              for part in "''${parts[@]}"; do
                case $part in
                  growrace)
                    echo "# growrace, without Emscripten's runtime: Node, as it tiers up, then each tier alone"
                    node ${memoryDir}/growrace-node.mjs 16 8192 "$growrace_runs" || true
                    node --liftoff --no-wasm-tier-up ${memoryDir}/growrace-node.mjs 16 8192 "$growrace_runs" || true
                    node --no-liftoff ${memoryDir}/growrace-node.mjs 16 8192 "$growrace_runs" || true
                    echo "# growrace: Bun, which is JavaScriptCore"
                    bun ${memoryDir}/growrace-node.mjs 16 8192 "$growrace_runs" || true
                    echo "# growrace: browsers"
                    node ${dist}/node/growrace.js --dir ${memoryDir} --runs "$growrace_runs" || true
                    echo "# growrace in C, through Emscripten's pthreads: Node"
                    for _ in 1 2 3 4 5; do
                      node ${growrace}/growrace.js 8 8192 2>&1 | grep -m1 'grown\|RuntimeError' || true
                    done
                    ;;
                  emufutex)
                    for build in growth fixed; do
                      echo "# GLib's 1bit-emufutex, $build memory, ''${EMUFUTEX_PARALLEL:-32} at once"
                      ${lib.getExe runEmufutex} "''${emufutex[$build]}" "$runs" "''${EMUFUTEX_PARALLEL:-32}"
                    done
                    ;;
                  node)
                    echo "# the runtime's workloads: Node"
                    node ${dist}/node/memory.js ${memoryArgs} ${variants.fixed} ${variants.growth} \
                      --runs "$runs" --parallel "$parallel" --costs --worker-memory || status=1
                    ;;
                  browsers)
                    echo "# the runtime's workloads: browsers"
                    node ${dist}/node/browser-memory.js ${memoryArgs} ${variants.fixed} ${variants.growth} \
                      ${variants.growable} --runs "$browser_runs" || status=1
                    ;;
                  *)
                    echo "no part $part" >&2
                    exit 2
                    ;;
                esac
              done
              exit $status
            '';
          }
        );
      };
    };
}
