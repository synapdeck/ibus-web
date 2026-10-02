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
      # requests isn't, so the pool is sized for the threads expected alive
      # at once, plus spares, and a thread beyond it fails with EAGAIN instead
      # of waiting for good. Each pool Worker holds an instance of the
      # runtime, as much memory again as the first (some 41–42 MiB under Node).
      threadShares = {
        # One GTask in flight keeps three alive, as measured: the thread of
        # GLib's worker context, where GTask's pool manager runs, and the
        # spawner of GLib's thread pools, both kept for good, and the GTask
        # worker the spawner starts, kept for 15.5 s after its last task
        # (half a second in the pool, then 15 s among unused threads). GTasks
        # in flight at once start more workers, up to GTask's pool size of ten
        # and past it while they all stay busy, which this share doesn't
        # cover.
        glib = 3;
        # The IndexedDB backends' threads: IndexedDB is asynchronous, so each
        # backend runs its calls on a thread of its own, from mount for good.
        # A host mounts two, each over a database of its own: the engine's
        # own files, and its version's data, which every version keeps apart
        # so that installing one never touches another in use. The Node
        # backend and the memory backend, mounted where there is no
        # IndexedDB, run on the calling thread and take none.
        storage = 2;
        # The spike's side modules' largest burst, spawn(4). An engine's
        # share would come from its manifest.
        engine = 4;
      };
      plannedThreads = lib.foldl' builtins.add 0 (lib.attrValues threadShares);
      # Spare Workers beyond the shares, which the pool starts with, so that
      # threads alive within the shares never leave fewer than this many
      # idle: GLib's share, since its first GTask needs all three of its
      # threads at once and GLib handles a failed creation badly (the worker
      # context's g_thread_new() aborts, a GTask pool whose spawner can't
      # start fails an assertion, and a GTask whose worker can't start stays
      # queued until a worker the pool already has is free, or for good if it
      # has none and no later push starts one). A thread an engine starts
      # beyond its share takes a spare rather than one GLib counts on, and
      # the host replaces the spares taken whenever no request is pending, so
      # the pool grows only when more threads are alive than the shares plan
      # for.
      lowWater = threadShares.glib;
      poolSize = plannedThreads + lowWater;

      # The least memory a host may give the runtime. It starts at 2.3 MiB
      # and each running thread adds about 1 MiB, mostly its stack, which
      # leaves room for a pool topped up well past its starting size.
      minimumMemory = 32 * 1024 * 1024;
      # The most: Emscripten's JavaScript reads addresses as signed 32-bit
      # numbers unless linked for more.
      maximumMemory = 2048 * 1024 * 1024;

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
        # Each runtime's memory is fixed: the host makes it, at the size its
        # engine's manifest gives, and passes it in as wasmMemory, which the
        # runtime refuses to start without. A memory that grows lets V8 trap
        # an atomic access, such as a libc++ shared pointer's count, to
        # memory another thread grew, until the accessing thread next
        # handles its interrupts (V8 issues 529880019 and 533026477, fixed
        # from V8 15.7, in no Node release line yet). Linked without growth,
        # the runtime has no way to grow its memory, whatever maximum the
        # host gave it, and a full heap aborts. Its memory import is declared
        # from the minimum up to maximumMemory, so that one runtime takes
        # every engine's size.
        "-sALLOW_MEMORY_GROWTH=0"
        "-sIMPORTED_MEMORY=1"
        "-sINITIAL_MEMORY=${toString minimumMemory}"
        "-sMAXIMUM_MEMORY=${toString maximumMemory}"
        # Also the default without growth. With assertions, the abort's
        # message advises a larger INITIAL_MEMORY or growth; the remedy is
        # a larger memory from the host.
        "-sABORTING_MALLOC=1"
        # Listing the settings the module takes drops noExitRuntime unless it
        # is named; without it, the runtime's thread exits after a callback
        # and retires its pthreads' Workers.
        "-sINCOMING_MODULE_JS_API=instantiateWasm,wasmMemory,noExitRuntime"
        "--pre-js=${./host-memory.js}"
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
            runtime.wasmfsIdb
            pkgsWasm.libffi
          ];
          # The output is files for the web, which need no fixing up and
          # depend on nothing.
          dontFixup = true;
          # Everything the runtime holds comes from libraries; the export
          # list decides what of them is linked, and the GIO subset, GObject,
          # libffi and the IndexedDB backend are on it whether libibus-web
          # uses them or not. The flags come after the libraries' own, which
          # set a pool size too.
          buildPhase = ''
            runHook preBuild
            $CXX $($PKG_CONFIG --static --libs libibus-web gio-2.0 gobject-2.0 libffi) \
              -lwasmfs-idb --js-library=${runtime.wasmfsIdb.jsLibrary} \
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
        inherit ibusRuntime link linkFlags;
        memory = {
          minimum = minimumMemory;
          maximum = maximumMemory;
        };
        threadPool = {
          shares = threadShares;
          size = poolSize;
          planned = plannedThreads;
          inherit lowWater;
        };
        ibusRuntimeAsserting = link {
          pname = "ibus-runtime-asserting";
          extraFlags = "-sASSERTIONS=1";
        };
      };
      packages.ibus-runtime = ibusRuntime;
    };
}
