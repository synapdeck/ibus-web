{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) toolchain;
      inherit (toolchain.pkgsWasm) libhangul;
    in
    {
      checks.dynlink-spike = pkgs.stdenvNoCC.mkDerivation {
        name = "ibus-web-dynlink-spike";
        src = ../../tests/spikes/dynlink;
        nativeBuildInputs = [
          pkgs.emscripten
          pkgs.nodejs
          toolchain.emscriptenCacheHook
        ];

        buildPhase = ''
          runHook preBuild
          flags="${toolchain.commonFlags} -O2"
          em++ $flags ${toolchain.testMainFlags} main.cpp -o main.js
          emcc $flags -sSIDE_MODULE=1 side_basic.c -o side_basic.wasm
          emcc $flags -sSIDE_MODULE=1 side_thread.c -o side_thread.wasm
          em++ $flags -sSIDE_MODULE=1 side_cxx.cpp -o side_cxx.wasm
          em++ $flags -sSIDE_MODULE=1 side_throw.cpp -o side_throw.wasm
          emcc $flags -sSIDE_MODULE=1 side_hangul.c \
            -I${libhangul}/include/hangul-1.0 ${libhangul}/lib/libhangul.a \
            -o side_hangul.wasm
          runHook postBuild
        '';

        doCheck = true;
        checkPhase = ''
          runHook preCheck
          # node exits non-zero on a probe FAIL, which would abort under set -e
          # before the diagnostics below ever printed. Capture the status and
          # exit with it after showing the output, instead of letting it kill
          # the phase early.
          node main.js $PWD/side_basic.wasm $PWD/side_thread.wasm $PWD/side_cxx.wasm \
            $PWD/side_throw.wasm $PWD/side_hangul.wasm > actual.txt || status=$?
          cat actual.txt
          diff -u expected.txt actual.txt
          if [ -n "''${status:-}" ]; then
            exit "$status"
          fi
          runHook postCheck
        '';

        installPhase = ''
          runHook preInstall
          mkdir -p $out
          cp actual.txt $out/
          runHook postInstall
        '';
      };
    };
}
