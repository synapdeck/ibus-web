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
      inherit (config.ibusWeb) toolchain runtime;
      inherit (toolchain) emscripten pkgsWasm;

      nodeHarness =
        pkgs.runCommand "ibus-runtime-node-harness"
          {
            nativeBuildInputs = [
              emscripten
              toolchain.emscriptenCacheHook
            ];
          }
          ''
            mkdir $out
            cp ${./tests/harness.mjs} $out/harness.mjs
            # Emscripten's errno values are WASI's, defined through macros of
            # its own, so the preprocessor evaluates each name.
            names=$(echo '#include <errno.h>' | emcc -dM -E -x c - |
              awk '$1 == "#define" && $2 ~ /^E[A-Z0-9]+$/ { print $2 }')
            { echo '#include <errno.h>'; for name in $names; do echo "\"$name\" $name"; done; } |
              emcc -E -P -x c - |
              awk 'BEGIN { printf "{" }
                $1 ~ /^"E[A-Z0-9]+"$/ && NF == 2 { gsub(/[()]/, "", $2); printf "%s%s: %d", sep, $1, $2; sep = ", " }
                END { print "}" }' > $out/errno.json
            grep -q '"ENOSYS": [0-9]' $out/errno.json
          '';

      # A side module of the runtime's own, for checks that outlive the
      # spike's.
      testSide = pkgsWasm.stdenv.mkDerivation {
        name = "ibus-runtime-test-side";
        src = ./tests;
        nativeBuildInputs = [ pkgsWasm.pkg-config ];
        buildInputs = [ runtime.libibusWeb ];
        buildPhase = ''
          runHook preBuild
          $CC $($PKG_CONFIG --cflags libibus-web) ${toolchain.sideModuleFlags} side.c -o side.wasm
          runHook postBuild
        '';
        installPhase = ''
          runHook preInstall
          install -Dm644 side.wasm $out/side.wasm
          runHook postInstall
        '';
      };

      # The functions the header marks as API, but for the entry point side
      # modules define.
      api = lib.remove "ibusweb_module_init" (
        lib.concatMap (
          line:
          let
            m = builtins.match "IBUSWEB_API [^(]* \\**([a-z_0-9]+)\\(.*" line;
          in
          lib.optional (m != null) (lib.head m)
        ) (lib.splitString "\n" (builtins.readFile "${runtime.libibusWeb.src}/include/ibus-web/runtime.h"))
      );

      # The runtime's header and its list must agree on the ABI version, and
      # the list must be one symbol per line, sorted, holding the runtime's
      # API.
      exportListCheck =
        pkgs.runCommand "ibus-web-ibus-runtime-exports-check"
          {
            api = lib.concatStringsSep " " api;
          }
          ''
            list=${runtime.exportList}/exports.txt
            test "$(head -n1 $list)" = "# IBUSWEB_RUNTIME_ABI ${toString runtime.exportList.abi}"
            symbols=$(tail -n +2 $list)
            if grep -Ev '^_[A-Za-z0-9_.$]+$' <<< "$symbols"; then
              echo "malformed lines above" >&2
              exit 1
            fi
            LC_ALL=C sort -c -u <<< "$symbols"
            test -n "$api"
            for name in $api; do
              if ! grep -Fxq "_$name" <<< "$symbols"; then
                echo "the API's $name is missing" >&2
                exit 1
              fi
            done
            echo "ABI ${toString runtime.exportList.abi}: $(wc -l <<< "$symbols") symbols, API: $api" > $out
            cat $out
          '';
    in
    {
      ibusWeb.runtime.nodeHarness = nodeHarness;

      checks.ibus-runtime-exports = exportListCheck;

      # The released and the asserting runtime each load a side module and
      # dispatch to it.
      checks.ibus-runtime-load =
        pkgs.runCommand "ibus-web-ibus-runtime-load-check"
          {
            nativeBuildInputs = [ pkgs.nodejs ];
          }
          ''
            cp ${nodeHarness}/* .
            cp ${./tests/load.mjs} load.mjs
            for build in ${runtime.ibusRuntime} ${runtime.ibusRuntimeAsserting}; do
              node load.mjs $build/ibus-runtime.js ${testSide}/side.wasm >> $out
            done
            cat $out
          '';

      checks.ibus-runtime-side-imports = runtime.checkSideModuleImports {
        name = "ibus-runtime-test-side";
        modules = [ "${testSide}/side.wasm" ];
      };
    };
}
