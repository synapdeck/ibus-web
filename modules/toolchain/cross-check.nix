{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb) toolchain;
      inherit (toolchain) pkgsWasm;
      inherit (pkgsWasm.stdenv) hostPlatform;
    in
    {
      # The probes go through the cross stdenv's own $CC and $CXX, so this
      # checks the wrapped compiler, its flags and the frozen cache together.
      checks.cross-toolchain =
        assert pkgsWasm.stdenv.cc.isClang;
        assert hostPlatform.isWasm && hostPlatform.isStatic;
        pkgsWasm.stdenv.mkDerivation {
          name = "ibus-web-cross-toolchain-check";
          src = ./_probes;
          nativeBuildInputs = [ pkgsWasm.nodejs ];
          buildPhase = ''
            runHook preBuild
            $CC -O2 -c probe.c -o probe.o
            $CXX ${toolchain.testMainFlags} probe.o -o probe-c.js
            $CXX ${toolchain.testMainFlags} probe.cpp -o probe-cpp.js
            test "$(node probe-c.js)" = "probe 7"
            test "$(node probe-cpp.js)" = "probe 2"
            runHook postBuild
          '';
          installPhase = "touch $out";
        };
    };
}
