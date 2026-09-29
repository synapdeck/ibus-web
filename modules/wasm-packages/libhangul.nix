{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb.toolchain) pkgsWasm;
    in
    {
      ibusWeb.wasmPackages.libhangul = pkgsWasm.libhangul;
      packages.libhangul-wasm = pkgsWasm.libhangul;
    };
}
