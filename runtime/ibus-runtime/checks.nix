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
      inherit (config.ibusWeb) toolchain runtime testing;
      inherit (toolchain) emscripten pkgsWasm;

      nodeHarness = pkgsWasm.stdenv.mkDerivation {
        name = "ibus-runtime-node-harness";
        dontUnpack = true;
        nativeBuildInputs = [
          pkgsWasm.pkg-config
          pkgs.python3
        ];
        buildInputs = [ runtime.libibusWeb ];
        dontFixup = true;
        installPhase = ''
          mkdir $out
          cp ${./tests/harness.ts} $out/harness.ts
          # Emscripten's errno values are WASI's, defined through macros of
          # its own, so the preprocessor evaluates each name.
          names=$(echo '#include <errno.h>' | $CC -dM -E -x c - |
            awk '$1 == "#define" && $2 ~ /^E[A-Z0-9]+$/ { print $2 }')
          { echo '#include <errno.h>'; for name in $names; do echo "\"$name\" $name"; done; } |
            $CC -E -P -x c - |
            awk 'BEGIN { printf "{" }
              $1 ~ /^"E[A-Z0-9]+"$/ && NF == 2 { gsub(/[()]/, "", $2); printf "%s%s: %d", sep, $1, $2; sep = ", " }
              END { print "}" }' > $out/errno.json
          grep -q '"ENOSYS": [0-9]' $out/errno.json
          echo '{"minimum": ${toString runtime.memory.minimum}, "maximum": ${toString runtime.memory.maximum}}' > $out/memory.json
          # What the header defines, as the target evaluates it.
          echo "{\"pumpError\": $(python3 ${./exports.py} macro --include ibus-web/runtime.h --pkg-config libibus-web IBUSWEB_PUMP_ERROR)}" > $out/constants.json
        '';
      };

      # Side modules of the runtime's own, for checks of the runtime alone.
      sideModule =
        {
          name,
          source,
          ...
        }@args:
        runtime.mkSideModule (
          removeAttrs args [ "source" ]
          // {
            src = lib.fileset.toSource {
              root = ./tests;
              fileset = ./tests + "/${source}";
            };
            sources = [ source ];
          }
        );
      testSide = sideModule {
        name = "side";
        source = "side.c";
      };
      cxxSide = sideModule {
        name = "cxx-side";
        source = "cxx-side.cpp";
      };
      throwSide = sideModule {
        name = "throw-side";
        source = "throw-side.cpp";
      };
      hangulSide = sideModule {
        name = "hangul-side";
        source = "hangul-side.c";
        buildInputs = [ pkgsWasm.libhangul ];
        pkgConfigModules = [ "libhangul" ];
      };
      sides = [
        testSide
        cxxSide
        throwSide
        hangulSide
      ];

      # The manifest's two files must agree, each library must be at the
      # version the build's inputs carry, and libibus-web and the IndexedDB
      # backend must each export exactly the API its header declares, but
      # for what side modules define.
      exportListCheck = pkgsWasm.stdenv.mkDerivation {
        name = "ibus-web-ibus-runtime-exports-check";
        dontUnpack = true;
        nativeBuildInputs = [
          pkgsWasm.pkg-config
          pkgs.python3
        ];
        buildInputs = [
          runtime.libibusWeb
          runtime.wasmfsIdb
        ];
        dontFixup = true;
        buildPhase = ''
          runHook preBuild
          for runtime in ${runtime.ibusRuntime} ${runtime.ibusRuntimeAsserting}; do
            cmp ${runtime.constants}/constants.json $runtime/constants.json
          done
          grep -F 'Module["ibuswebEngineThreads"]' ${runtime.ibusRuntime}/ibus-runtime.js > /dev/null
          manifest=${runtime.exportList}
          for file in exports.txt exports.json; do
            cmp $manifest/$file ${runtime.ibusRuntime}/$file
          done
          macro() { python3 ${./exports.py} macro "$@"; }
          abi=$(macro --include ibus-web/runtime.h --pkg-config libibus-web IBUSWEB_RUNTIME_ABI)
          musl=$(< ${config.ibusWeb.lib.emscriptenRoot}/system/lib/libc/musl/VERSION)
          # libc++ numbers its release XXYYZZ.
          libcxx=$(macro --lang c++ --include version _LIBCPP_VERSION)
          # compiler-rt is the compiler's own runtime, tied to it by the LLVM
          # major release; only that is compared, so a patch release of one
          # without the other doesn't fail the check.
          clang=$(macro __clang_major__)
          python3 ${./exports.py} verify --dir $manifest \
            --expect libibus-web=$abi \
            --expect "ibus=$($PKG_CONFIG --modversion ibus-1.0)+ibus-web.$abi" \
            ${
              lib.concatMapStringsSep " " (library: "--expect ${library}=${pkgsWasm.glib.version}") [
                "glib-2.0"
                "gobject-2.0"
                "gmodule-2.0"
                "gio-2.0"
              ]
            } \
            --expect libffi=${pkgsWasm.libffi.version} \
            --expect wasmfs-idb=$abi \
            --expect "libc=$musl+emscripten.${emscripten.version}" \
            --expect "libc++=$((libcxx / 10000)).$((libcxx / 100 % 100)).$((libcxx % 100))" \
            --expect-major compiler-rt=$clang \
            --expect emscripten=${emscripten.version} \
            --api libibus-web=ibus-web/runtime.h --api wasmfs-idb=ibus-web/wasmfs-idb.h \
            --api-subset ibus=ibus.h --api-pkg-config ibus-1.0 \
            --api-hidden libibus-web --api-pkg-config libibus-web \
            --api-side-defined ibusweb_module_init \
            > summary.txt
          cat summary.txt
          runHook postBuild
        '';
        installPhase = ''
          cp summary.txt $out
        '';
      };
    in
    {
      ibusWeb.runtime = { inherit nodeHarness; };

      checks.ibus-runtime-exports = exportListCheck;
      checks.ibus-runtime-exports-script =
        pkgs.runCommand "ibus-runtime-exports-script"
          {
            CC = "${emscripten.llvmEnv}/bin/clang";
            CXX = "${emscripten.llvmEnv}/bin/clang++";
          }
          ''
            cp ${./exports.py} exports.py
            cp ${./test-exports.py} test-exports.py
            ${pkgs.python3}/bin/python3 -B test-exports.py > $out 2>&1
            cat $out
          '';

      # The released and the asserting runtime each load side modules (C,
      # C++, and one with a static library linked in) and dispatch to them,
      # under Node.
      checks.ibus-runtime-load = testing.programs {
        name = "ibus-runtime-load";
        environments = [ "node" ];
        programs = [ ];
        nodeTests = ./tests;
        nodeTestData = {
          harness = "${nodeHarness}";
          constants = "${runtime.constants}/constants.json";
          released = "${runtime.ibusRuntime}/ibus-runtime.js";
          asserting = "${runtime.ibusRuntimeAsserting}/ibus-runtime.js";
          side = testSide.wasm;
          cxxSide = cxxSide.wasm;
          throwSide = throwSide.wasm;
          hangulSide = hangulSide.wasm;
        };
      };

      checks.ibus-runtime-side-imports = runtime.checkSideModuleImports {
        name = "ibus-runtime-test-sides";
        modules = map (side: side.wasm) sides;
      };
    };
}
