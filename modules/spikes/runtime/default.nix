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
      inherit (toolchain) pkgsWasm;

      sides =
        map
          (
            { name, source }:
            runtime.mkSideModule {
              inherit name;
              src = ../../../tests/spikes/runtime/sides;
              sources = [ source ];
            }
          )
          [
            {
              name = "trivial";
              source = "trivial.c";
            }
            {
              name = "thread";
              source = "thread.c";
            }
            {
              name = "throw";
              source = "throw.cpp";
            }
            {
              name = "fsync";
              source = "fsync.c";
            }
            {
              name = "proxy";
              source = "proxy.c";
            }
            {
              name = "timer";
              source = "timer.c";
            }
            {
              name = "memstress";
              source = "memstress.c";
            }
            {
              name = "tree";
              source = "tree.c";
            }
            {
              name = "bench";
              source = "bench.c";
            }
          ];

      # The values the TypeScript side shares with the C side, as the
      # WebAssembly target defines them, and the runtime's memory bounds.
      constants = pkgsWasm.stdenv.mkDerivation {
        name = "ibus-web-runtime-spike-constants";
        src = ../../../tests/spikes/runtime/sides;
        nativeBuildInputs = [
          pkgsWasm.pkg-config
          typescript.nodejs
          pkgs.jq
        ];
        buildInputs = [ runtime.libibusWeb ];
        dontFixup = true;
        buildPhase = ''
          runHook preBuild
          $CC $($PKG_CONFIG --cflags libibus-web) -I${runtime.wasmfsIdb}/include \
            -c constants.c -o constants.o
          $CXX ${toolchain.testMainFlags} constants.o -o constants.js
          node constants.js |
            jq -c --argjson minimum ${toString runtime.memory.minimum} \
              --argjson maximum ${toString runtime.memory.maximum} \
              '. + { memory: { $minimum, $maximum } }' > constants.json
          runHook postBuild
        '';
        installPhase = ''
          runHook preInstall
          install -Dm644 constants.json -t $out
          runHook postInstall
        '';
      };

      sidesDir = pkgs.runCommand "ibus-web-runtime-spike-sides" { } ''
        mkdir $out
        ln -s ${toString (map (side: side.wasm) sides)} $out/
      '';

      # Scenarios size their thread counts by the pool the runtime is linked
      # with, its shares and the spare Workers beyond them, which the host
      # tops the pool back up to; they check that threads within the shares
      # leave the pool as it is, and GLib's share against what a GTask keeps
      # alive.
      harnessArgs = lib.concatStringsSep " " [
        "--sides ${sidesDir}"
        "--errno ${runtime.nodeHarness}/errno.json"
        "--constants ${constants}/constants.json"
        "--pool ${toString runtime.threadPool.size}"
        "--planned-threads ${toString runtime.threadPool.planned}"
        "--engine-threads ${toString runtime.threadPool.shares.engine}"
        "--glib-threads ${toString runtime.threadPool.shares.glib}"
        "--pool-low-water ${toString runtime.threadPool.lowWater}"
      ];
      # The hosts make the runtime's memory at its least size, which the
      # spike's side modules fit in.
      memoryArg = "--memory ${toString runtime.memory.minimum}";
      # The engine's data the hosts install, and the archives the install
      # scenarios use.
      installArg = "--install-data ${runtime.installArchives}";
      dist = "${typescript.workspace}/tests/spikes/runtime/dist";

      # The released runtime, linked also with a library that gives each
      # database the IndexedDB backend creates whose name ends in
      # "-chunk-<bytes>" chunks of that size, for the measurements alone; the
      # runtime as released has no such setting.
      chunkSizeRuntime = runtime.link {
        pname = "ibus-runtime-chunk-sizes";
        extraFlags = "--js-library=${./chunk-size.js} -sDEFAULT_LIBRARY_FUNCS_TO_INCLUDE='$wasmfsIdbChunkSizeByName'";
      };
      # The chunk sizes the measurements compare, in bytes.
      chunkSizes = map (kib: kib * 1024) [
        16
        64
        256
      ];

      # A browser run's own limits catch a host that stops answering; this
      # catches a browser or harness that hangs outright.
      browserTimeout = "timeout --kill-after=10 900";
    in
    {
      # The IndexedDB backend's header comes with no pkg-config module.
      ibusWeb.toolchain.clangdPathFlags."tests/spikes/runtime/sides/constants\\.c" = [
        "-I${runtime.wasmfsIdb}/include"
      ];

      # The asserting runtime loads every spike side module and runs each
      # operation once.
      checks.runtime-spike-smoke =
        pkgs.runCommand "ibus-web-runtime-spike-smoke"
          {
            nativeBuildInputs = [ typescript.nodejs ];
          }
          ''
            cp ${runtime.nodeHarness}/* .
            cp ${./smoke.mjs} smoke.mjs
            ${runtime.nodeTimeout} node smoke.mjs ${runtime.ibusRuntimeAsserting}/ibus-runtime.js ${sidesDir} \
              ${constants}/constants.json > $out
            cat $out
          '';

      # The Worker host, from the TypeScript build, runs every scenario under
      # Node, and the crash scenario on a host of its own: on the asserting
      # runtime for correctness, then on the released one, whose timings are
      # the ones to quote.
      checks.runtime-spike-node =
        pkgs.runCommand "ibus-web-runtime-spike-node"
          {
            nativeBuildInputs = [ typescript.nodejs ];
            # For running the harness by hand from a checkout.
            passthru = {
              inherit constants sidesDir browserTimeout;
              inherit (runtime) ibusRuntime ibusRuntimeAsserting nodeHarness;
            };
          }
          ''
            # The exceptions scenario's operation throws on purpose, and the
            # runtime warns about it on stderr, as it reports the traps of
            # thread-crash and heap-full. The filter is a pipe, so it has
            # finished by the time run returns.
            run() (
              set -o pipefail
              ${runtime.nodeTimeout} node ${dist}/node/run.js ${harnessArgs} ${memoryArg} ${installArg} "$@" 2>&1 1>&3 3>&- |
                sed -e '/ibus-web-WARNING.*Operation [0-9]* threw/s/$/ [expected: the exceptions scenario]/' \
                  -e '/RuntimeError: unreachable/s/$/ [expected: the thread-crash and heap-full scenarios]/' >&2
            ) 3>&1
            echo "# asserting runtime" > $out
            run --runtime ${runtime.ibusRuntimeAsserting}/ibus-runtime.js >> $out || { cat $out; exit 1; }
            echo "# released runtime" >> $out
            run --runtime ${runtime.ibusRuntime}/ibus-runtime.js >> $out || { cat $out; exit 1; }
            cat $out
          '';

      # The Worker host in headless Chromium and Firefox, through Playwright:
      # a page served with cross-origin isolation starts it by URL and drives
      # it over the control buffer, spinning for each reply. The asserting
      # runtime runs for correctness, then the released one for the timings.
      checks.runtime-spike-browser =
        pkgs.runCommand "ibus-web-runtime-spike-browser"
          (
            {
              nativeBuildInputs = [ typescript.nodejs ];
              passthru = {
                inherit constants sidesDir;
                inherit (runtime) ibusRuntime ibusRuntimeAsserting nodeHarness;
              };
            }
            // playwright.env
          )
          ''
            ${playwright.setup}
            # Browser console output goes to stderr, where the warnings the
            # exceptions scenario's throw, pool-exhausted's failed thread
            # creations, the traps of thread-crash and heap-full, and the
            # connections storage-closed and failed-start-releases-locks
            # close cause are marked expected.
            run() (
              set -o pipefail
              ${browserTimeout} node ${dist}/node/browser-run.js ${harnessArgs} ${memoryArg} ${installArg} "$@" 2>&1 1>&3 3>&- |
                sed -e '/ibus-web-WARNING.*Operation [0-9]* threw/s/$/ [expected: the exceptions scenario]/' \
                  -e '/WARNING.*spawn: thread [0-9]* of [0-9]*: Error creating thread: Resource temporarily unavailable/s/$/ [expected: the pool-exhausted scenario]/' \
                  -e '/Tried to spawn a new thread, but the thread pool is exhausted/s/$/ [expected: the pool-exhausted scenario]/' \
                  -e '/RuntimeError: unreachable/s/$/ [expected: the thread-crash and heap-full scenarios]/' \
                  -e '/wasmfs-idb: ibus-web\/spike closed for a version change/s/$/ [expected: the storage-closed scenario]/' \
                  -e '/wasmfs-idb: looking up after-close.txt failed: I\/O error/s/$/ [expected: the storage-closed scenario]/' \
                  -e '/wasmfs-idb: ibus-web\/failed-start-releases-locks\/data\/[^ ]* closed for a version change/s/$/ [expected: the failed-start-releases-locks scenario, whose next host deletes the data the failed one opened]/' >&2
            ) 3>&1
            echo "# asserting runtime" > $out
            run --runtime ${runtime.ibusRuntimeAsserting}/ibus-runtime.js >> $out || { cat $out; exit 1; }
            echo "# released runtime" >> $out
            run --runtime ${runtime.ibusRuntime}/ibus-runtime.js >> $out || { cat $out; exit 1; }
            cat $out
          '';

      # The released runtime's scenarios with the comparisons, under Node and
      # then in the browsers, run from a checkout: an idle host that waits
      # asynchronously, a relay-less one that sleeps in Atomics.wait() on the
      # control buffer, and in the browsers a page that waits
      # asynchronously.
      # Arguments go to the browser harness, such as --browser firefox.
      apps.runtime-spike-compare = {
        type = "app";
        meta.description = "The runtime spike's scenarios with the comparisons, under Node and in headless Chromium and Firefox";
        program = lib.getExe (
          pkgs.writeShellApplication {
            name = "runtime-spike-compare";
            runtimeInputs = [ typescript.nodejs ];
            text = ''
              ${lib.toShellVars playwright.env}
              export ${lib.concatStringsSep " " (lib.attrNames playwright.env)}
              runtime=${runtime.ibusRuntime}/ibus-runtime.js
              echo "# Node" >&2
              node ${dist}/node/run.js ${harnessArgs} ${memoryArg} ${installArg} --runtime "$runtime" --compare
              echo "# browsers" >&2
              node ${dist}/node/browser-run.js ${harnessArgs} ${memoryArg} ${installArg} --runtime "$runtime" --compare "$@"
            '';
          }
        );
      };

      # What the IndexedDB backend costs, on the released runtime linked for
      # measurement, in headless Chromium and Firefox: storage-costs for each
      # chunk size, with the page spinning for each reply and then idle.
      # Arguments go to the browser harness, such as --browser firefox.
      apps.runtime-spike-storage-costs = {
        type = "app";
        meta.description = "The IndexedDB backend's read, write and fsync costs and storage overhead for each chunk size, in headless Chromium and Firefox";
        program = lib.getExe (
          pkgs.writeShellApplication {
            name = "runtime-spike-storage-costs";
            runtimeInputs = [ typescript.nodejs ];
            text = ''
              ${lib.toShellVars playwright.env}
              export ${lib.concatStringsSep " " (lib.attrNames playwright.env)}
              node ${dist}/node/browser-run.js ${harnessArgs} ${memoryArg} ${installArg} \
                --runtime ${chunkSizeRuntime}/ibus-runtime.js --measure \
                ${lib.concatMapStringsSep " " (bytes: "--chunk-size ${toString bytes}") chunkSizes} "$@"
            '';
          }
        );
      };

      # The browser behaviour the spike depends on, measured without the
      # runtime: when nested Workers start, which OPFS calls wait for the
      # page's main thread, and which sync access handles can be open on one
      # file at once.
      apps.runtime-spike-experiments = {
        type = "app";
        meta.description = "Browser experiments behind the runtime spike: nested Workers, OPFS and sync access handle locks";
        program = lib.getExe (
          pkgs.writeShellApplication {
            name = "runtime-spike-experiments";
            runtimeInputs = [ typescript.nodejs ];
            text = ''
              ${lib.toShellVars playwright.env}
              export ${lib.concatStringsSep " " (lib.attrNames playwright.env)}
              node ${dist}/node/experiments.js "$@"
            '';
          }
        );
      };

      # Where engine data could live, measured without the runtime: whether
      # IndexedDB, Cache Storage and OPFS reads in a Worker wait for the
      # page's main thread while it spins, what two Workers or pages can do
      # to the same data at once, and random-read latency.
      apps.runtime-spike-storage = {
        type = "app";
        meta.description = "Storage experiments behind the runtime spike: IndexedDB, Cache Storage and OPFS reads under the page's spin";
        program = lib.getExe (
          pkgs.writeShellApplication {
            name = "runtime-spike-storage";
            runtimeInputs = [ typescript.nodejs ];
            text = ''
              ${lib.toShellVars playwright.env}
              export ${lib.concatStringsSep " " (lib.attrNames playwright.env)}
              node ${dist}/node/storage.js "$@"
            '';
          }
        );
      };

      checks.runtime-spike-side-imports = runtime.checkSideModuleImports {
        name = "runtime-spike";
        modules = map (side: side.wasm) sides;
      };
    };
}
