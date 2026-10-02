# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{ inputs, ... }:
{
  perSystem =
    {
      config,
      lib,
      pkgs,
      system,
      ...
    }:
    let
      inherit (pkgs) hk;
      inherit (config.ibusWeb) toolchain typescript;

      # hk's own release ships Builtins.pkl inside a pkl package that hk.pkl
      # would import by `package://` URL, which can't resolve offline; nixpkgs'
      # hk embeds none. This generates the same package from hk's source.
      sourceVersion = (lib.importTOML "${hk.src}/Cargo.toml").package.version;
      hkPkl =
        lib.throwIfNot (sourceVersion == hk.version)
          "hk-pkl: pkgs.hk is ${hk.version}, but its source declares ${sourceVersion}"
          (
            pkgs.stdenvNoCC.mkDerivation {
              pname = "hk-pkl";
              inherit (hk) version src;
              nativeBuildInputs = [
                pkgs.pkl
                pkgs.python3
              ];
              buildPhase = ''
                runHook preBuild
                export HOME=$TMPDIR
                python3 scripts/gen_builtins.py
                runHook postBuild
              '';
              installPhase = ''
                runHook preInstall
                mkdir -p $out
                cp -R pkl $out/pkl
                runHook postInstall
              '';
            }
          );

      # The LLVM emcc drives, so formatting agrees with the clangd editors run.
      clangFormat = pkgs.runCommand "ibus-web-clang-format" { } ''
        mkdir -p $out/bin
        ln -s ${toolchain.emscripten.llvmEnv}/bin/clang-format $out/bin/clang-format
      '';

      tools = [
        hk
        pkgs.pkl
        pkgs.oxfmt
        pkgs.oxlint
        pkgs.nixfmt
        clangFormat
        pkgs.shfmt
        pkgs.reuse
        pkgs.actionlint
      ];
      # The dev shell gets the workspace's TypeScript from the workspace's
      # own module.
      checkTools = tools ++ [
        pkgs.git
        typescript.nodejs
        typescript.tsc
      ];
    in
    {
      packages.hk-pkl = hkPkl;

      # The hooks' own run, over the flake source: every file git tracks.
      checks.hk =
        pkgs.runCommand "ibus-web-hk"
          {
            nativeBuildInputs = checkTools;
            HK_REQUIRE_NIX_INPUTS = "1";
            HK_PKL_OFFLINE = "1";
            # hk's pkl evaluator builds an HTTP client even offline, and that
            # fails without a CA bundle to load.
            SSL_CERT_FILE = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
          }
          ''
            cp -r --no-preserve=mode ${inputs.self} src
            cd src
            git init -q
            git add -A
            # Each link is git-ignored, as in a checkout.
            ln -s ${hkPkl} .hk
            ln -s ${config.packages.wasmfs-idb-types} runtime/wasmfs-idb/src/emscripten-types
            (
              cd ${typescript.workspace}
              find . -name node_modules -prune -print
            ) | while IFS= read -r modules; do
              ln -s ${typescript.workspace}/"$modules" "$modules"
            done
            export HOME=$TMPDIR/home HK_STATE_DIR=$TMPDIR/hk-state HK_CACHE_DIR=$TMPDIR/hk-cache
            hk check --all --no-fail-fast --no-progress
            touch $out
          '';

      formatter = pkgs.writeShellApplication {
        name = "ibus-web-format";
        runtimeInputs = checkTools;
        text = ''
          cd "''${FLAKE_ROOT:-$(${lib.getExe config.flake-root.package})}"
          if [ "$(readlink .hk)" != ${hkPkl} ]; then
            ln -sfn ${hkPkl} .hk
          fi
          exec hk fix --all "$@"
        '';
      };

      devshells.default = {
        packages = tools;
        devshell.startup.hk.text = ''
          nix build "$FLAKE_ROOT#packages.${system}.hk-pkl" --out-link "$FLAKE_ROOT/.hk" ||
            echo "hk's pkl package unavailable" >&2
          # Reinstalling replaces hk's earlier hooks, so this is safe on
          # every start.
          if [ -e "$FLAKE_ROOT/.hk" ]; then
            (cd "$FLAKE_ROOT" && hk install) || echo "hk install failed" >&2
          fi
        '';
      };
    };
}
