# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) runtime;

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
          ];
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
            mkdir sides
            ln -s ${toString (map (side: side.wasm) sides)} sides/
            node smoke.mjs ${runtime.ibusRuntimeAsserting}/ibus-runtime.js sides > $out
            cat $out
          '';

      checks.runtime-spike-side-imports = runtime.checkSideModuleImports {
        name = "runtime-spike";
        modules = map (side: side.wasm) sides;
      };
    };
}
