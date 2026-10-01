# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) runtime toolchain typescript;
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
          ];

      # The values the TypeScript side shares with the C side, as the
      # WebAssembly target defines them.
      constants = pkgsWasm.stdenv.mkDerivation {
        name = "ibus-web-runtime-spike-constants";
        src = ../../../tests/spikes/runtime/sides;
        nativeBuildInputs = [
          pkgsWasm.pkg-config
          pkgs.nodejs
        ];
        buildInputs = [ runtime.libibusWeb ];
        dontFixup = true;
        buildPhase = ''
          runHook preBuild
          $CC $($PKG_CONFIG --cflags libibus-web) -c constants.c -o constants.o
          $CXX ${toolchain.testMainFlags} constants.o -o constants.js
          node constants.js > constants.json
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
      # with.
      poolSize = builtins.head (builtins.match ".*-sPTHREAD_POOL_SIZE=([0-9]+).*" runtime.linkFlags);
    in
    {
      # The asserting runtime loads every spike side module and runs each
      # operation once.
      checks.runtime-spike-smoke =
        pkgs.runCommand "ibus-web-runtime-spike-smoke"
          {
            nativeBuildInputs = [ pkgs.nodejs ];
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
      # the ones to quote, with the comparisons against an idle host that
      # waits asynchronously and a relay-less one that sleeps in
      # Atomics.wait() on the control buffer.
      checks.runtime-spike-node =
        pkgs.runCommand "ibus-web-runtime-spike-node"
          {
            nativeBuildInputs = [ typescript.nodejs ];
            # For running the harness by hand from a checkout.
            passthru = {
              inherit constants sidesDir;
              inherit (runtime) ibusRuntime ibusRuntimeAsserting nodeHarness;
            };
          }
          ''
            # The exceptions scenario's operation throws on purpose, and the
            # runtime warns about it on stderr. The filter is a pipe, so it
            # has finished by the time run returns.
            run() (
              set -o pipefail
              ${runtime.nodeTimeout} node ${typescript.workspace}/tests/spikes/runtime/dist/node/run.js \
                --sides ${sidesDir} --errno ${runtime.nodeHarness}/errno.json \
                --constants ${constants}/constants.json --pool ${poolSize} "$@" 2>&1 1>&3 3>&- |
                sed '/ibus-web-WARNING.*Operation [0-9]* threw/s/$/ [expected: the exceptions scenario]/' >&2
            ) 3>&1
            echo "# asserting runtime" > $out
            run --runtime ${runtime.ibusRuntimeAsserting}/ibus-runtime.js >> $out || { cat $out; exit 1; }
            echo "# released runtime" >> $out
            run --runtime ${runtime.ibusRuntime}/ibus-runtime.js --compare >> $out || { cat $out; exit 1; }
            cat $out
          '';

      checks.runtime-spike-side-imports = runtime.checkSideModuleImports {
        name = "runtime-spike";
        modules = map (side: side.wasm) sides;
      };
    };
}
