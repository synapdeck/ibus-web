# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{
  perSystem =
    { config, lib, ... }:
    let
      inherit (config.ibusWeb) testing toolchain;
      inherit (toolchain) pkgsWasm;
      inherit (pkgsWasm.stdenv) hostPlatform;

      # Overlays gate on the platform; this proves a gated overlay applies to
      # the WASM set, stays out of its build tools, and evaluates at all.
      probe =
        final: prev:
        lib.optionalAttrs
          (prev.stdenv.hostPlatform.isWasm && (prev.stdenv.hostPlatform.useEmscripten or false))
          {
            ibusWebOverlayProbe = true;
          };
      probed = pkgsWasm.appendOverlays [ probe ];
    in
    {
      # The probes go through the cross stdenv's own $CC and $CXX, so this
      # checks the wrapped compiler, its flags and the frozen cache together.
      checks.cross-toolchain =
        assert pkgsWasm.stdenv.cc.isClang;
        assert hostPlatform.isWasm && hostPlatform.isStatic;
        assert probed.ibusWebOverlayProbe or false;
        assert !(probed.buildPackages.ibusWebOverlayProbe or false);
        pkgsWasm.stdenv.mkDerivation {
          name = "ibus-web-cross-toolchain-check";
          src = ../probes;
          nativeBuildInputs = [ pkgsWasm.nodejs ];
          buildPhase = ''
            runHook preBuild
            $CC -O2 -c probe.c -o probe.o
            $CXX ${toolchain.testMainFlags} probe.o -o probe-c.js
            $CXX ${toolchain.testMainFlags} probe.cpp -o probe-cpp.js
            test "$(node probe-c.js)" = "probe 7"
            test "$(node probe-cpp.js)" = "probe 2"
            # Flags clang and lld accept must not reach emcc or wasm-ld.
            $CC -O2 -static-libgcc -c probe.c -o probe-flags.o 2> flags.log
            test ! -s flags.log
            $CXX ${toolchain.testMainFlags} -Wl,--undefined-version probe-flags.o -o probe-flags.js
            test "$(node probe-flags.js)" = "probe 7"
            # Links, and only links, target the project's minimum versions.
            $CC -O2 -Werror=unused-command-line-argument -c probe.c -o probe-compiled.o
            EMCC_DEBUG=1 EMCC_TEMP_DIR=$PWD $CXX ${toolchain.testMainFlags} probe.o \
              -o probe-minimums.js 2> minimums.log
            # The wrapper hands emcc a response file, which emcc logs as a
            # Python list.
            minimums="'$(sed "s/ /', '/g" ${toolchain.minimumVersions}/link-flags)'"
            grep -qF -- "$minimums" minimums.log
            # A link for some environments only gets the minimums emcc uses
            # for them, so it warns about none; the last ENVIRONMENT wins.
            EMCC_DEBUG=1 EMCC_TEMP_DIR=$PWD $CC ${testing.browserLinkFlags} \
              -Werror=unused-command-line-argument probe-compiled.o -o probe-worker.js 2> worker.log \
              || { cat worker.log >&2; exit 1; }
            grep -qF -- "-sMIN_FIREFOX_VERSION=" worker.log
            if grep -qF -- "-sMIN_NODE_VERSION=" worker.log; then
              echo "a worker link was given Node's minimum" >&2
              exit 1
            fi
            EMCC_DEBUG=1 EMCC_TEMP_DIR=$PWD $CXX ${toolchain.testMainFlags} -sENVIRONMENT=web \
              -s ENVIRONMENT=node -Werror=unused-command-line-argument probe.o -o probe-node.js 2> node.log \
              || { cat node.log >&2; exit 1; }
            grep -qF -- "-sMIN_NODE_VERSION=" node.log
            if grep -qF -- "-sMIN_FIREFOX_VERSION=" node.log; then
              echo "a Node link was given the browsers' minimums" >&2
              exit 1
            fi
            test "$(node probe-node.js)" = "probe 7"
            # Every compile is optimized unless the package asks otherwise.
            echo | $CC -dM -E -x c - | grep -q "__OPTIMIZE__"
            echo | $CC -O0 -dM -E -x c - > O0.h
            if grep -q "__OPTIMIZE__" O0.h; then
              echo "a package's -O0 must override the common -O2" >&2
              exit 1
            fi
            runHook postBuild
          '';
          installPhase = "touch $out";
        };
    };
}
