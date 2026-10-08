# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      inherit (config.ibusWeb) testing toolchain;
      # WasmFS's internal headers, for a test of its backend threads.
      wasmfsInclude = config.ibusWeb.lib.wasmfsIncludeFlag;

      # The imported memory's sizes, in MiB: the module is linked for the
      # initial size and declares the maximum, and runs with each of sizes.
      initialMiB = 16;
      maximumMiB = 64;
      sizes = [
        initialMiB
        48
        maximumMiB
      ];

      # The dlopen() cases' threads' stacks, which the cases size room for.
      threadStackSize = 64 * 1024;

      program =
        args:
        testing.program (
          {
            src = ./.;
            derivationName = "ibus-web-emscripten-fixes-${args.name}";
          }
          // args
        );

      # A side module beside the program, under each of names, which the
      # program finds through SIDE_MODULE_DIR.
      sideModules = names: ''
        $CC ${toolchain.sideModuleFlags} dlsync-side.c -o dlsync-side.wasm
        ${lib.concatMapStrings (name: "install -Dm644 dlsync-side.wasm $out/${name}\n") names}
      '';
      dlsync =
        name: names:
        program {
          inherit name;
          extraSources = [ "dlsync-side.c" ];
          # dlopen() takes a main module, whose sync the cases are about.
          linkFlags = "${toolchain.testMainFlags} -sDEFAULT_PTHREAD_STACK_SIZE=${toString threadStackSize}";
          cflags = ''-DSIDE_MODULE_DIR=\"$out\" -DTHREAD_STACK_SIZE=${toString threadStackSize}'';
          preBuild = sideModules names;
        };

      # Without growth, but with a maximum above the initial size; the link
      # fails where emcc ignores the maximum, which it warns about. The
      # pre-js sizes the memory from the program's argument.
      importedMemoryModule = program {
        name = "imported-memory-maximum";
        format = null;
        gtest = true;
        linkFlags = [
          "-sASSERTIONS=1"
          "-Werror=unused-command-line-argument"
          "-sALLOW_MEMORY_GROWTH=0"
          "-sABORTING_MALLOC=0"
          "-sIMPORTED_MEMORY=1"
          "-sINITIAL_MEMORY=${toString initialMiB}MB"
          "-sMAXIMUM_MEMORY=${toString maximumMiB}MB"
          # The case's thread, beside GoogleTest's.
          "-sPTHREAD_POOL_SIZE=2"
          "-sEXIT_RUNTIME=1"
          "--pre-js=${./size-pre.js}"
        ];
      };

      # The module under a program name of its own for each size, which it
      # takes as its argument. The JavaScript loads the module by its link's
      # name.
      importedMemory =
        mib:
        let
          name = "imported-memory-maximum-${toString mib}";
          module = importedMemoryModule;
        in
        pkgs.runCommand "ibus-web-${name}"
          {
            passthru.testProgram = {
              inherit name;
              format = "gtest-json";
            };
          }
          ''
            mkdir $out
            cp ${module}/imported-memory-maximum.js $out/${name}.js
            ln -s ${module}/imported-memory-maximum.wasm $out/imported-memory-maximum.wasm
            ln -s ${module}/imported-memory-maximum.wasm $out/${name}.wasm
            echo ${toString mib} > $out/${name}.args
          '';

      # Its exit status is the evidence, which only the test file sees.
      dlsyncExit = program {
        name = "dlsync-exit";
        sources = [ "dlsync-exit.c" ];
        extraSources = [ "dlsync-side.c" ];
        format = null;
        linkFlags = toolchain.testMainFlags;
        preBuild = sideModules [ "dlsync-side.wasm" ];
      };
    in
    {
      ibusWeb.toolchain.clangdPathFlags."modules/emscripten/checks/fixes/.*\\.(cpp|h)" = [
        wasmfsInclude
      ]
      ++ testing.gtestCflagList;
      # The build names the directory of a dlopen() case's side modules and
      # its threads' stack size; the editor only needs the names defined.
      ibusWeb.toolchain.clangdPathFlags."modules/emscripten/checks/fixes/dlsync-.*\\.cpp" = [
        ''-DSIDE_MODULE_DIR="."''
        "-DTHREAD_STACK_SIZE=${toString threadStackSize}"
      ];

      # The behaviour each of the toolchain's Emscripten fixes restores, on
      # the file system test programs run on (WasmFS under Node), for the
      # standard streams on the one GLib's tools run on (Node's own), and for
      # threads under a main thread that never returns to its event loop or
      # that loads a module while they run, for the Worker a destroyed WasmFS
      # backend thread leaves in the pool, and for a memory imported, without
      # growth, at a size between its initial size and its maximum.
      checks.emscripten-fixes = testing.programs {
        name = "emscripten-fixes";
        environments = [ "node" ];
        programs = [
          (program {
            name = "wasmfs-node";
            linkFlags = testing.nodeLinkFlags;
          })
          (program {
            name = "fstat-stdio";
            linkFlags = "-sASSERTIONS=1 -sNODERAWFS=1 -sEXIT_RUNTIME=1";
          })
          (program {
            name = "thread-cleanup";
            linkFlags = testing.nodeLinkFlags;
          })
          (dlsync "dlsync-freed" [ "dlsync-side.wasm" ])
          (dlsync "dlsync-held" [
            "dlsync-side.wasm"
            "dlsync-side2.wasm"
          ])
          (dlsync "dlsync-reused" [ "dlsync-side.wasm" ])
          # A Worker for GoogleTest's thread and one for each of the case's
          # two.
          (program {
            name = "proxy-worker";
            cflags = wasmfsInclude;
            linkFlags = "${testing.nodeLinkFlags} -sPTHREAD_POOL_SIZE=3";
          })
        ]
        ++ map importedMemory sizes;
        nodeTests = ./.;
        nodeTestData = {
          dlsyncExit = "${dlsyncExit}/dlsync-exit.js";
          dlsyncSide = "${dlsyncExit}/dlsync-side.wasm";
          importedMemoryWasm = "${importedMemoryModule}/imported-memory-maximum.wasm";
          importedMemoryMaximumMiB = toString maximumMiB;
        };
      };
    };
}
