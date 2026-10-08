# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) runtime testing typescript;

      # A side module whose dylink section the tests read.
      fixture = runtime.mkSideModule {
        name = "manifest-fixture";
        src = ./.;
        sources = [ "fixture.c" ];
      };
    in
    {
      checks.engine-manifest =
        (testing.vitestCheck {
          name = "engine-manifest";
          packageDir = "${typescript.workspaceFor [ "tools/engine-manifest" ]}/tools/engine-manifest";
          env.IBUS_WEB_DYLINK_FIXTURE = fixture.wasm;
          inBrowsers = false;
          limit = 60;
        }).overrideAttrs
          (old: {
            nativeBuildInputs = (old.nativeBuildInputs or [ ]) ++ [ pkgs.wabt ];
          });
    };
}
