{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.toolchain = {
      commonFlags = lib.mkOption {
        type = lib.types.str;
        description = "Compiler flags every WASM object is built with.";
      };
      testMainFlags = lib.mkOption {
        type = lib.types.str;
        description = "Link flags for Node-run test programs; a combination the library cache covers.";
      };
      emscriptenCache = lib.mkOption {
        type = lib.types.package;
        description = "Emscripten cache prebuilt for this project's library variants.";
      };
      emscriptenCacheHook = lib.mkOption {
        type = lib.types.package;
        description = "Setup hook giving each build a private copy of the cache.";
      };
      wasmStdenv = lib.mkOption {
        type = lib.types.raw;
        description = "stdenv that builds nixpkgs recipes as static PIC WASM libraries.";
      };
    };
  };
}
