{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb.toolchain) pkgsWasm;
    in
    {
      # nixpkgs' Meson setup hook writes the cross file; this proves it, the
      # cross pkg-config and both libraries in one program.
      checks.meson-consumer = pkgsWasm.stdenv.mkDerivation {
        name = "ibus-web-meson-consumer";
        src = ./src;
        nativeBuildInputs = [
          pkgsWasm.meson
          pkgsWasm.ninja
          pkgsWasm.pkg-config
          pkgsWasm.nodejs
        ];
        buildInputs = [
          pkgsWasm.zlib
          pkgsWasm.libffi
        ];
        # Recipes such as GLib's pass defines this way; main.c refuses to
        # compile if the wrapper drops them.
        env.NIX_CFLAGS_COMPILE = "-DIBUS_WEB_RECIPE_CFLAGS";
        installPhase = ''
          runHook preInstall
          mkdir -p $out
          node consumer.js | tee $out/output.txt
          grep -qx "zlib ok" $out/output.txt
          grep -qx "ffi 42" $out/output.txt
          runHook postInstall
        '';
      };
    };
}
