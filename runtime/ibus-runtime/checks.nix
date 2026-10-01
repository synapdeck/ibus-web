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

      # A side module of the runtime's own, for checks of the runtime alone.
      testSide = runtime.mkSideModule {
        name = "side";
        src = lib.fileset.toSource {
          root = ./tests;
          fileset = ./tests/side.c;
        };
        sources = [ "side.c" ];
      };

      # The manifest's two files must agree, each library must be at the
      # version the build's inputs carry, and libibus-web must export exactly
      # the API its header declares, but for what side modules define.
      exportListCheck = pkgsWasm.stdenv.mkDerivation {
        name = "ibus-web-ibus-runtime-exports-check";
        dontUnpack = true;
        nativeBuildInputs = [
          pkgsWasm.pkg-config
          pkgs.python3
        ];
        buildInputs = [ runtime.libibusWeb ];
        dontFixup = true;
        buildPhase = ''
          runHook preBuild
          manifest=${runtime.exportList}
          for file in exports.txt exports.json; do
            cmp $manifest/$file ${runtime.ibusRuntime}/$file
          done
          macro() { python3 ${./exports.py} macro "$@"; }
          abi=$(macro --include ibus-web/runtime.h --pkg-config libibus-web IBUSWEB_RUNTIME_ABI)
          musl=$(< ${emscripten}/share/emscripten/system/lib/libc/musl/VERSION)
          # libc++ numbers its release XXYYZZ.
          libcxx=$(macro --lang c++ --include version _LIBCPP_VERSION)
          # compiler-rt is the compiler's own runtime, from its release.
          clang=$(macro __clang_major__).$(macro __clang_minor__).$(macro __clang_patchlevel__)
          python3 ${./exports.py} verify --dir $manifest \
            --expect libibus-web=$abi \
            ${
              lib.concatMapStringsSep " " (library: "--expect ${library}=${pkgsWasm.glib.version}") [
                "glib-2.0"
                "gobject-2.0"
                "gmodule-2.0"
                "gio-2.0"
              ]
            } \
            --expect libffi=${pkgsWasm.libffi.version} \
            --expect "libc=$musl+emscripten.${emscripten.version}" \
            --expect "libc++=$((libcxx / 10000)).$((libcxx / 100 % 100)).$((libcxx % 100))" \
            --expect compiler-rt=$clang \
            --expect emscripten=${emscripten.version} \
            --api-library libibus-web --api-header ibus-web/runtime.h --api-pkg-config libibus-web \
            --api-side-defined ibusweb_module_init \
            > summary.txt
          cat summary.txt
          runHook postBuild
        '';
        installPhase = ''
          cp summary.txt $out
        '';
      };

      # A blocked main thread (a join on a thread that never ends, say) never
      # returns to Node's event loop, where a timer would fire.
      nodeTimeout = "timeout --kill-after=10 300";
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
              ${nodeTimeout} node load.mjs $build/ibus-runtime.js ${testSide.wasm} >> $out
            done
            cat $out
          '';

      checks.ibus-runtime-side-imports = testSide.importsCheck;
    };
}
