{
  perSystem =
    { config, lib, ... }:
    let
      inherit (config.ibusWeb) toolchain;
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
          src = ./probes;
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
            runHook postBuild
          '';
          installPhase = "touch $out";
        };
    };
}
