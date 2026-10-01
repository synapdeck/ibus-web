# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, lib, ... }:
    let
      inherit (config.ibusWeb) toolchain runtime;
      inherit (toolchain) pkgsWasm;
      inherit (runtime) exportList;

      # Threads come from a pool of Workers started with the runtime. A
      # browser starts a Worker created later only once the thread that
      # created it is back in its event loop, which a host blocked serving
      # requests isn't, so the pool is sized for the most threads alive at
      # once, and a thread beyond it fails with EAGAIN instead of waiting for
      # good. Each pool Worker holds an instance of the runtime, as much
      # memory again as the first (some 45 MiB under Node).
      threadShares = {
        # The first GTask starts three, as measured: the thread of GLib's
        # worker context, where GTask's pool manager runs, and the spawner of
        # GLib's thread pools, both kept for good, and the GTask worker the
        # spawner starts, kept for 15.5 s after its last task (half a second
        # in the pool, then 15 s among unused threads).
        glib = 3;
        # WasmFS's OPFS backend runs its calls on a thread of its own, from
        # mount for good.
        opfs = 1;
        # The spike's side modules' largest burst, spawn(4). An engine's
        # share would come from its manifest.
        engine = 4;
      };
      # glib 3 + opfs 1 + engine 4 = 8
      poolSize = lib.foldl' builtins.add 0 (lib.attrValues threadShares);

      linkFlags = lib.concatStringsSep " " [
        toolchain.runtimeMainFlags
        # The Worker host reads and writes requests in the runtime's memory,
        # and tops Emscripten's pthread pool up while it is idle.
        "-sEXPORTED_RUNTIME_METHODS=HEAPU8,PThread"
        "-sPTHREAD_POOL_SIZE=${toString poolSize}"
        "-sPTHREAD_POOL_SIZE_STRICT=2"
        # GRegex outgrows Emscripten's 64 KiB default stack, on any thread.
        "-sSTACK_SIZE=1MB"
        "-sDEFAULT_PTHREAD_STACK_SIZE=1MB"
        # A fixed memory, without growth until what engines need sets a
        # sizing rule. The runtime starts at 2.3 MiB and each running thread
        # adds about 1 MiB, mostly its stack, so the pool's eight threads
        # peak near 10.3 MiB; 32 MiB leaves room for a pool topped up well
        # past that.
        "-sALLOW_MEMORY_GROWTH=0"
        "-sINITIAL_MEMORY=32MB"
        "-sMODULARIZE=1"
        "-sEXPORT_ES6=1"
        "-sENVIRONMENT=web,worker,node"
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
          # The output is files for the web, which need no fixing up and
          # depend on nothing.
          dontFixup = true;
          # Everything the runtime holds comes from libraries; the export
          # list decides what of them is linked, and the GIO subset, GObject
          # and libffi are on it whether libibus-web uses them or not. The
          # flags come after the libraries' own, which set a pool size too.
          buildPhase = ''
            runHook preBuild
            $CXX $($PKG_CONFIG --static --libs libibus-web gio-2.0 gobject-2.0 libffi) \
              ${linkFlags} -sEXPORTED_FUNCTIONS=@${exportList}/exports.txt ${extraFlags} \
              -o ibus-runtime.js
            runHook postBuild
          '';
          installPhase = ''
            runHook preInstall
            mkdir -p $out
            cp ibus-runtime.js ibus-runtime.wasm ${exportList}/exports.txt ${exportList}/exports.json $out/
            runHook postInstall
          '';
        };

      ibusRuntime = link { pname = "ibus-runtime"; };
    in
    {
      ibusWeb.runtime = {
        inherit ibusRuntime linkFlags;
        threadPool = {
          shares = threadShares;
          size = poolSize;
          # GLib's first GTask needs all three of its threads at once, and
          # GLib handles a failed creation badly: the worker context's
          # g_thread_new() aborts, a GTask pool whose spawner can't start
          # fails an assertion, and a GTask whose worker can't start stays
          # queued until a later one's can.
          # The pool's own size already covers the expected peak, so the
          # top-up only keeps that much room when an engine overshoots its
          # share.
          lowWater = threadShares.glib;
        };
        ibusRuntimeAsserting = link {
          pname = "ibus-runtime-asserting";
          extraFlags = "-sASSERTIONS=1";
        };
      };
      packages.ibus-runtime = ibusRuntime;
    };
}
