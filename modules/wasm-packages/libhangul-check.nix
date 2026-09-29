{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb) toolchain wasmPackages;
      inherit (toolchain) pkgsWasm;
      libhangul = wasmPackages.libhangul;
      pkgConfig = "${pkgsWasm.stdenv.cc.targetPrefix}pkg-config";
    in
    {
      # Builds against the installed library through the cross pkg-config,
      # the way an engine will find it.
      checks.libhangul-wasm =
        assert libhangul.stdenv.hostPlatform.isWasm;
        pkgsWasm.runCommandCC "ibus-web-libhangul-check"
          {
            nativeBuildInputs = [
              pkgsWasm.nodejs
              pkgsWasm.pkg-config
            ];
            buildInputs = [ libhangul ];
          }
          ''
            $CC -O2 $(${pkgConfig} --cflags libhangul) -c ${./_tests/libhangul-test.c} -o libhangul-test.o
            $CXX ${toolchain.testMainFlags} libhangul-test.o $(${pkgConfig} --libs libhangul) -o libhangul-test.js
            node libhangul-test.js | tee $out
            grep -qx "preedit U+D55C" $out
          '';
    };
}
