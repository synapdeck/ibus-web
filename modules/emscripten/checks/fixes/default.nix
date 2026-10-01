# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) toolchain;
    in
    {
      # The behaviour each of the toolchain's Emscripten fixes restores, on
      # the file system test programs run on (WasmFS under Node) and, for the
      # standard streams, on the one GLib's tools run on (Node's own).
      checks.emscripten-fixes =
        pkgs.runCommand "ibus-web-emscripten-fixes"
          {
            nativeBuildInputs = [
              toolchain.emscripten
              pkgs.nodejs
              toolchain.emscriptenCacheHook
            ];
          }
          ''
            emcc ${toolchain.commonFlags} -O2 -c ${./fixes.c} -o fixes.o
            em++ ${toolchain.commonFlags} ${toolchain.testMainFlags} fixes.o -o fixes.js
            mkdir host
            # A lock-order regression in the racing renames would hang.
            timeout 300 node fixes.js $PWD/host

            emcc ${toolchain.commonFlags} -O2 -c ${./fstat-stdio.c} -o fstat-stdio.o
            emcc ${toolchain.commonFlags} -O2 -sASSERTIONS=1 -sNODERAWFS=1 -sEXIT_RUNTIME=1 \
              fstat-stdio.o -o fstat-stdio.js
            node fstat-stdio.js < /dev/null
            touch $out
          '';
    };
}
