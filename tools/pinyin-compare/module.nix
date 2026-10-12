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
      inherit (config.ibusWeb) testing typescript;

      workspace = typescript.workspaceFor [ "tools/pinyin-compare" ];

      corpusPython = pkgs.python3.withPackages (ps: [
        ps.opencc
        ps.pypinyin
      ]);
    in
    {
      # Run once to write the committed corpus; Tatoeba replaces its exports
      # weekly, so the corpus is never rebuilt from one.
      apps.pinyin-compare-corpus = {
        type = "app";
        program = lib.getExe (
          pkgs.writeShellApplication {
            name = "ibus-web-pinyin-compare-corpus";
            text = ''
              exec ${corpusPython}/bin/python3 -I ${./generate-corpus.py} "$@"
            '';
          }
        );
      };

      checks.tools-pinyin-compare = testing.vitestCheck {
        name = "tools-pinyin-compare";
        packageDir = "${workspace}/tools/pinyin-compare";
        env = { };
        inBrowsers = false;
        limit = 60;
      };
    };
}
