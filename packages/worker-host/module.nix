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

      sidesSrc = ./test/sides;

      # The test side modules the host's tests load together; their opcodes
      # are unique across them.
      sides =
        map
          (
            source:
            runtime.mkSideModule {
              name = lib.removeSuffix ".c" (lib.removeSuffix ".cpp" source);
              src = sidesSrc;
              sources = [ source ];
            }
          )
          [
            "trivial.c"
            "thread.c"
            "throw.cpp"
            "proxy.c"
            "timer.c"
            "memstress.c"
            "fsync.c"
            "bench.c"
            "tree.c"
          ];

      sidesDir = pkgs.runCommand "ibus-web-worker-host-test-sides" { } ''
        mkdir $out
        ln -s ${toString (map (side: side.wasm) sides)} $out/
      '';

      # The values the tests share with the C side, as the WebAssembly target
      # defines them, and the runtime's memory bounds.
      constants = pkgsWasm.stdenv.mkDerivation {
        name = "ibus-web-worker-host-test-constants";
        src = sidesSrc;
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

      # Scenarios size their thread counts by the pool the runtime is linked
      # with: its shares, and the spare Workers beyond them, which the host
      # tops the pool back up to. The memory workloads run with the threads
      # the pool plans for alive at once, which leaves the spares idle, so the
      # host never tops up during them, in the runtime's least memory: their
      # heap's break peaked under 20 MiB in every environment.
      manifest =
        environments:
        pkgs.writeText "ibus-web-worker-host-tests.json" (
          builtins.toJSON {
            inherit environments;
            runtimes = {
              asserting = "${runtime.ibusRuntimeAsserting}";
              released = "${runtime.ibusRuntime}";
            };
            sides = "${sidesDir}";
            constants = "${constants}/constants.json";
            errno = "${runtime.nodeHarness}/errno.json";
            archives = "${runtime.installArchives}";
            pool = {
              inherit (runtime.threadPool) size planned lowWater;
              inherit (runtime.threadPool.shares) engine glib;
            };
            stress = {
              threads = runtime.threadPool.planned;
              rounds = 24;
              iterations = 10000;
            };
          }
        );

      packageDir = "${typescript.workspace}/packages/worker-host";

      # Each runs the host's tests on the asserting runtime and the released
      # one, from the built package.
      check =
        name: environments:
        let
          inBrowsers = environments != [ "node" ];
        in
        pkgs.runCommand "ibus-web-${name}"
          (
            {
              nativeBuildInputs = [ typescript.nodejs ];
              IBUS_WEB_WORKER_HOST_TESTS = manifest environments;
              # Nix gives a build a terminal, on which Vitest would redraw its
              # progress into the log, over and over.
              CI = "1";
              passthru = {
                # For running the tests from a checkout.
                manifest = manifest environments;
                inherit constants;
              };
            }
            // lib.optionalAttrs inBrowsers playwright.env
          )
          ''
            ${if inBrowsers then playwright.setup else "export HOME=$(mktemp -d)"}
            export IBUS_WEB_TEST_CACHE_DIR=$TMPDIR/vite
            mkdir $out
            cd ${packageDir}
            set -o pipefail
            # Vitest holds each test to its own limit; this catches a browser
            # or Vitest that hangs outright.
            timeout --kill-after=10 1800 node node_modules/vitest/vitest.mjs run --configLoader native \
              2>&1 | tee $out/output.txt
          '';
    in
    {
      # The IndexedDB backend's header comes with no pkg-config module.
      ibusWeb.toolchain.clangdPathFlags."packages/worker-host/test/sides/constants\\.c" = [
        "-I${runtime.wasmfsIdb}/include"
      ];

      checks.worker-host-node = check "worker-host-node" [ "node" ];
      checks.worker-host-browser = check "worker-host-browser" [
        "chromium"
        "firefox"
      ];
      checks.worker-host-side-imports = runtime.checkSideModuleImports {
        name = "worker-host-test-sides";
        modules = map (side: side.wasm) sides;
      };
    };
}
