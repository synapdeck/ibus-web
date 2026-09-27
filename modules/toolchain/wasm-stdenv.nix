{
  perSystem =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      inherit (pkgs) emscripten;
      inherit (config.ibusWeb.toolchain) commonFlags emscriptenCacheHook;

      wasmBuildHook = pkgs.makeSetupHook {
        name = "wasm-build-hook";
        substitutions = {
          inherit commonFlags;
          nm = "${emscripten.llvmEnv}/bin/llvm-nm";
        };
      } ./_wasm-build-hook.sh;
    in
    {
      # Emscripten is clang, so recipes that branch on the compiler
      # (stdenv.cc.isClang) must take their clang paths.
      ibusWeb.toolchain.wasmStdenv = pkgs.clangStdenv // {
        mkDerivation =
          fnOrAttrs:
          pkgs.clangStdenv.mkDerivation (
            finalAttrs:
            let
              args = lib.toFunction fnOrAttrs finalAttrs;
            in
            args
            // {
              nativeBuildInputs = (args.nativeBuildInputs or [ ]) ++ [
                emscripten
                emscriptenCacheHook
                wasmBuildHook
                pkgs.nodejs
              ];
              # Side modules link libraries statically, so only .a files are wanted.
              configureFlags = (args.configureFlags or [ ]) ++ [
                "--host=wasm32-unknown-emscripten"
                "--enable-static"
                "--disable-shared"
              ];
              dontDisableStatic = true;
              dontStrip = true;
              dontPatchELF = true;
              doCheck = false;
            }
          );
      };
    };
}
