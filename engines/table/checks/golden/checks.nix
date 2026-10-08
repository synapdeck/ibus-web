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
      inherit (config.ibusWeb.engines.table) tables tools;
    in
    {
      # The tools' build with the golden tests turned on, run by Meson.
      checks.table-golden = tools.overrideAttrs (old: {
        pname = "ibus-web-table-golden";

        src = lib.fileset.toSource {
          root = ../..;
          fileset = lib.fileset.unions [
            ../../meson.build
            ../../meson.options
            ../../src
            ../../native
            ../../tables/xsampa.table
            ./golden.cpp
            ./recorder.hpp
          ];
        };

        mesonFlags = (old.mesonFlags or [ ]) ++ [ "-Dtests=true" ];
        buildInputs = old.buildInputs ++ [ pkgs.gtest ];

        # latex.table is generated, so the tests read it from the tables' build.
        IBUS_WEB_LATEX_TABLE = "${tables}/latex.table";

        doCheck = true;
        checkPhase = ''
          runHook preCheck
          ${config.ibusWeb.lib.mesonAllTestsRan "table-golden"}
          runHook postCheck
        '';

        installPhase = ''
          runHook preInstall
          mkdir $out
          cp meson-logs/testlog.txt $out/
          runHook postInstall
        '';
      });
    };
}
