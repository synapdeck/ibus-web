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

      # hk's pkl package, with the Builtins.pkl its release generates. The
      # released package is only reachable by `package://` URL, which can't
      # resolve offline, and nixpkgs' hk embeds none.
      hkPkl = pkgs.stdenvNoCC.mkDerivation {
        pname = "hk-pkl";
        inherit (hk) version src;
        nativeBuildInputs = [
          pkgs.pkl
          pkgs.python3
        ];
        # The package must describe the hk that evaluates it.
        postPatch = ''
          declared=$(sed -n 's/^version = "\(.*\)"$/\1/p' Cargo.toml | head -n 1)
          if [ "$declared" != ${lib.escapeShellArg hk.version} ]; then
            echo "hk's source declares $declared, but pkgs.hk is ${hk.version}" >&2
            exit 1
          fi
        '';
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
      };

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

      emscriptenTypeLinks = pkgs.writeText "ibus-web-emscripten-type-links" (
        lib.concatLines (
          lib.sort lib.lessThan (lib.mapAttrsToList (_: types: types.link) toolchain.emscriptenTypes)
        )
      );

      # Beyond what the dev shell already has.
      checkTools = tools ++ [
        pkgs.git
        typescript.nodejs
        typescript.tsc
      ];
    in
    {
      packages.hk-pkl = hkPkl;

      # The hooks' own run, over the flake source: every file git tracks.
      checks.flake-hk =
        pkgs.runCommand "ibus-web-flake-hk"
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

            # Linked after `git add`, and git-ignored, as in a checkout.
            ln -s ${hkPkl} .hk

            # hk.pkl's nixInputs are exactly the registry's links: a link it
            # lacks goes unchecked, and an entry the registry lacks is never
            # built or linked.
            awk '/^local nixInputs =/ { listing = 1 } listing { print } listing && /\)/ { exit }' hk.pkl \
              | grep -o '"[^"]*"' | tr -d '"' | LC_ALL=C sort > $TMPDIR/nix-inputs
            if ! diff -u ${emscriptenTypeLinks} $TMPDIR/nix-inputs >&2; then
              echo "hk.pkl's nixInputs (+) differ from ibusWeb.toolchain.emscriptenTypes' links (-)" >&2
              exit 1
            fi
            ${lib.concatStrings (
              lib.mapAttrsToList (_: types: ''
                ln -s ${types.package} ${types.link}
              '') toolchain.emscriptenTypes
            )}

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
          # Paths given are relative to where `nix fmt` ran.
          files=()
          for file in "$@"; do
            files+=("$(realpath -- "$file")")
          done
          cd "''${FLAKE_ROOT:-$(${lib.getExe config.flake-root.package})}"
          if [ "$(readlink .hk)" != ${hkPkl} ]; then
            ln -sfn ${hkPkl} .hk
          fi
          if [ ''${#files[@]} -eq 0 ]; then
            exec hk fix --all
          fi
          exec hk fix "''${files[@]}"
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
