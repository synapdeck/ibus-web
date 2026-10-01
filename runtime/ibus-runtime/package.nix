# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, lib, ... }:
    let
      inherit (config.ibusWeb) toolchain runtime;
      inherit (toolchain) pkgsWasm;
      inherit (runtime) exportList;

      linkFlags = lib.concatStringsSep " " [
        toolchain.runtimeMainFlags
        "-sEXPORTED_FUNCTIONS=@${exportList}/exports.txt"
        # The Worker host reads and writes requests in the runtime's memory.
        "-sEXPORTED_RUNTIME_METHODS=HEAPU8"
        # Threads come from a pool started with the runtime, so creating one
        # never waits for the event loop, which a Worker blocked waiting for
        # requests doesn't return to. Each pool Worker holds an instance of
        # the runtime, as much memory again as the first (some 45 MiB under
        # Node), so the pool is small: GLib's own (a GTask worker and the
        # thread-pool spawner that starts it) and two for an engine.
        "-sPTHREAD_POOL_SIZE=4"
        # GRegex outgrows Emscripten's 64 KiB default stack, on any thread.
        "-sSTACK_SIZE=1MB"
        "-sDEFAULT_PTHREAD_STACK_SIZE=1MB"
        # A fixed memory: growth has let pthreads fault out of bounds. The
        # runtime starts at 2.3 MiB, and each running thread adds about
        # 1 MiB, mostly its stack; four at once peak at 7.4 MiB.
        "-sALLOW_MEMORY_GROWTH=0"
        "-sINITIAL_MEMORY=32MB"
        "-sMODULARIZE=1"
        "-sEXPORT_ES6=1"
        "-sENVIRONMENT=web,worker,node"
        "-sEXIT_RUNTIME=0"
      ];

      link =
        {
          pname,
          extraFlags ? "",
        }:
        pkgsWasm.stdenv.mkDerivation {
          inherit pname;
          inherit (runtime.libibusWeb) version;
          dontUnpack = true;
          nativeBuildInputs = [ pkgsWasm.pkg-config ];
          buildInputs = [
            runtime.libibusWeb
            pkgsWasm.libffi
          ];
          passthru = { inherit (exportList) abi; };
          # The output is three files for the web, which need no fixing up
          # and depend on nothing.
          dontFixup = true;
          # Everything the runtime holds comes from libraries; the export
          # list decides what of them is linked, and the GIO subset, GObject
          # and libffi are on it whether libibus-web uses them or not. The
          # flags come after the libraries' own, which set a pool size too.
          buildPhase = ''
            runHook preBuild
            $CXX $($PKG_CONFIG --static --libs libibus-web gio-2.0 gobject-2.0 libffi) \
              ${linkFlags} ${extraFlags} -o ibus-runtime.js
            runHook postBuild
          '';
          installPhase = ''
            runHook preInstall
            mkdir -p $out
            cp ibus-runtime.js ibus-runtime.wasm ${exportList}/exports.txt $out/
            runHook postInstall
          '';
        };

      ibusRuntime = link { pname = "ibus-runtime"; };
    in
    {
      ibusWeb.runtime = {
        inherit ibusRuntime;
        ibusRuntimeAsserting = link {
          pname = "ibus-runtime-asserting";
          extraFlags = "-sASSERTIONS=1";
        };
      };
      packages.ibus-runtime = ibusRuntime;
    };
}
