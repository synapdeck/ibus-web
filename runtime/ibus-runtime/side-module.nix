# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, lib, ... }:
    let
      inherit (config.ibusWeb) toolchain runtime;
      inherit (toolchain) pkgsWasm;

      isCxx =
        file:
        lib.any (suffix: lib.hasSuffix suffix file) [
          ".cpp"
          ".cc"
          ".cxx"
        ];
    in
    {
      ibusWeb.runtime.mkSideModule =
        {
          name,
          src,
          sources,
        }:
        let
          linker = if lib.any isCxx sources then "$CXX" else "$CC";
          object = file: "${file}.o";
          module = pkgsWasm.stdenv.mkDerivation {
            name = "ibus-web-side-module-${name}";
            inherit src;
            nativeBuildInputs = [ pkgsWasm.pkg-config ];
            buildInputs = [ runtime.libibusWeb ];
            buildPhase = ''
              runHook preBuild
              cflags="$($PKG_CONFIG --cflags libibus-web)"
              ${lib.concatMapStrings (file: ''
                ${if isCxx file then "$CXX" else "$CC"} $cflags -c ${
                  lib.escapeShellArgs [
                    file
                    "-o"
                    (object file)
                  ]
                }
              '') sources}
              ${linker} ${toolchain.sideModuleFlags} ${lib.escapeShellArgs (map object sources)} \
                -o ${lib.escapeShellArg "${name}.wasm"}
              runHook postBuild
            '';
            installPhase = ''
              runHook preInstall
              install -Dm644 ${lib.escapeShellArg "${name}.wasm"} -t $out
              runHook postInstall
            '';
            passthru = {
              wasm = "${module}/${name}.wasm";
              importsCheck = runtime.checkSideModuleImports {
                inherit name;
                modules = [ "${module}/${name}.wasm" ];
              };
            };
          };
        in
        module;
    };
}
