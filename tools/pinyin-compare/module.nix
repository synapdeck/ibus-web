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

      drivers = pkgs.stdenv.mkDerivation {
        name = "ibus-web-pinyin-compare-drivers";
        src = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [
            ./libpinyin-convert.c
            ./rime-session.c
          ];
        };

        nativeBuildInputs = [ pkgs.pkg-config ];
        buildInputs = [
          pkgs.glib
          pkgs.libpinyin
          pkgs.librime
        ];

        # GNU C23: pinyin.h uses bool without stdbool.h, and the drivers use
        # POSIX getline.
        buildPhase = ''
          runHook preBuild
          $CC -std=gnu23 -O2 -Wall -Wextra -Werror libpinyin-convert.c $(pkg-config --cflags --libs libpinyin) -o libpinyin-convert
          $CC -std=gnu23 -O2 -Wall -Wextra -Werror rime-session.c $(pkg-config --cflags --libs rime) -o rime-session
          runHook postBuild
        '';

        installPhase = ''
          runHook preInstall
          install -Dm755 -t $out/bin libpinyin-convert rime-session
          runHook postInstall
        '';
      };

      # rime-ice as its users install it: its suggested default.yaml, which
      # nixpkgs installs under another name, is the default configuration. Its
      # empty build/ is left out, since Rime reads a shared build/ as prebuilt
      # data.
      rimeData = pkgs.runCommand "ibus-web-pinyin-compare-rime-data" { } ''
        mkdir $out
        for file in ${pkgs.rime-ice}/share/rime-data/*; do
          [ "$(basename "$file")" = build ] || ln -s "$file" $out/
        done
        ln -s ${pkgs.rime-ice}/share/rime-data/rime_ice_suggestion.yaml $out/default.yaml
      '';

      # clangd reads the repository's C as WebAssembly; the drivers are native.
      nativeClangd =
        pkgs.runCommand "ibus-web-pinyin-compare-clangd"
          {
            inherit (drivers) buildInputs;
            nativeBuildInputs = [ pkgs.pkg-config ];
          }
          ''
            {
              echo 'If:'
              echo '  PathMatch: tools/pinyin-compare/.*\.c'
              echo 'CompileFlags:'
              echo '  Compiler: ${pkgs.stdenv.cc}/bin/cc'
              echo '  Remove: [-isystem, -fwasm-exceptions, -mextended-const]'
              echo '  Add:'
              echo '    - -std=gnu23'
              for flag in $(pkg-config --cflags libpinyin rime); do
                echo "    - $flag"
              done
            } > $out
          '';

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

      # nixpkgs builds libpinyin for Linux alone.
      ibusWeb.toolchain = lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
        clangdFragments = [ nativeClangd ];
        clangdQueryDrivers = [ "${pkgs.stdenv.cc}/bin/cc" ];
      };

      # A finding rather than a check: the scores neither pass nor fail.
      packages = lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
        ibus-web-pinyin-compare-report =
          pkgs.runCommand "ibus-web-pinyin-compare-report"
            {
              nativeBuildInputs = [ typescript.nodejs ];
              passthru = { inherit drivers rimeData; };
            }
            ''
              export HOME=$(mktemp -d)
              node ${workspace}/tools/pinyin-compare/report.ts \
                --corpus ${workspace}/tools/pinyin-compare/corpus.tsv \
                --out $out \
                --libpinyin-convert ${drivers}/bin/libpinyin-convert \
                --libpinyin-data ${pkgs.libpinyin}/lib/libpinyin/data \
                --rime-session ${drivers}/bin/rime-session \
                --rime-data ${rimeData} \
                --libpinyin-version "libpinyin ${pkgs.libpinyin.version}, with ibus-libpinyin ${pkgs.ibus-engines.libpinyin.version}'s default options" \
                --rime-version "librime ${pkgs.librime.version}, rime-ice ${pkgs.rime-ice.version}"
            '';
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
