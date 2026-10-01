# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) runtime typescript;

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
            ${runtime.nodeTimeout} node smoke.mjs ${runtime.ibusRuntimeAsserting}/ibus-runtime.js ${sidesDir} > $out
            cat $out
          '';

      # The Worker host, from the TypeScript build, runs every scenario under
      # Node: on the asserting runtime for correctness, then on the released
      # one, whose timings are the ones to quote, with the comparison against
      # a host that sleeps in Atomics.wait() on the control buffer.
      checks.runtime-spike-node =
        pkgs.runCommand "ibus-web-runtime-spike-node"
          {
            nativeBuildInputs = [ typescript.nodejs ];
            # For running the harness by hand from a checkout.
            passthru = {
              inherit sidesDir;
              inherit (runtime) ibusRuntime ibusRuntimeAsserting nodeHarness;
            };
          }
          ''
            run() {
              ${runtime.nodeTimeout} node ${typescript.workspace}/tests/spikes/runtime/dist/node/run.js \
                --sides ${sidesDir} --errno ${runtime.nodeHarness}/errno.json --pool ${poolSize} "$@"
            }
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
