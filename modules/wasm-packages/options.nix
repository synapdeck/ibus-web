{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.wasmPackages = lib.mkOption {
      type = lib.types.lazyAttrsOf lib.types.package;
      default = { };
      description = "WASM packages from the Emscripten cross package set, keyed by nixpkgs attribute name.";
    };
  };
}
