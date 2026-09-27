{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) toolchain;

      libhangul = (pkgs.libhangul.override { stdenv = toolchain.wasmStdenv; }).overrideAttrs (old: {
        pname = "libhangul-wasm";
        configureFlags = old.configureFlags ++ [ "--disable-nls" ];

        doInstallCheck = true;
        installCheckPhase = ''
          runHook preInstallCheck
          emcc ${toolchain.commonFlags} -O2 -I$out/include/hangul-1.0 \
            -c ${./_tests/libhangul-test.c} -o libhangul-test.o
          em++ ${toolchain.commonFlags} ${toolchain.testMainFlags} \
            libhangul-test.o $out/lib/libhangul.a -o libhangul-test.js
          node libhangul-test.js
          runHook postInstallCheck
        '';
      });
    in
    {
      ibusWeb.wasmPackages.libhangul = libhangul;
      packages.libhangul-wasm = libhangul;
      # nix flake check skips building packages; this runs the install check.
      checks.libhangul-wasm = libhangul;
    };
}
