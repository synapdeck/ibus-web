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
      inherit (config.ibusWeb) toolchain runtime;
      inherit (toolchain) emscripten pkgsWasm;
      emscriptenRoot = "${emscripten}/share/emscripten";

      # Emscripten records the LLVM release each library it imports from LLVM
      # comes from in that library's README. libc++abi's and libunwind's rest
      # on it alone: their version macros (_LIBCPPABI_VERSION,
      # _LIBUNWIND_VERSION) are frozen at 15000, and nothing else records
      # them.
      llvmImport = library: {
        file = "${emscriptenRoot}/system/lib/${library}/README.md";
        pattern = "based on release ([0-9]+\\.[0-9]+\\.[0-9]+)";
      };

      # Each library the runtime carries for side modules: the version it is
      # at, and the symbols it contributes, which are those it defines with
      # default visibility, narrowed for some by a rule. A symbol two
      # libraries define is the first one's.
      spec = {
        abi = "abi";
        versions = {
          abi = {
            include = "ibus-web/runtime.h";
            macros = [ "IBUSWEB_RUNTIME_ABI" ];
            packages = [ "libibus-web" ];
          };
          ibus = {
            include = "ibusversion.h";
            macros = [
              "IBUS_MAJOR_VERSION"
              "IBUS_MINOR_VERSION"
              "IBUS_MICRO_VERSION"
            ];
            packages = [ "ibus-1.0" ];
          };
          glib.modversion = "glib-2.0";
          libffi.modversion = "libffi";
          emscripten = {
            include = "emscripten/version.h";
            macros = [
              "__EMSCRIPTEN_MAJOR__"
              "__EMSCRIPTEN_MINOR__"
              "__EMSCRIPTEN_TINY__"
            ];
          };
          musl = {
            file = "${emscriptenRoot}/system/lib/libc/musl/VERSION";
            pattern = "^([0-9][0-9.]*)$";
          };
          compilerRt = llvmImport "compiler-rt";
          libcxx = llvmImport "libcxx";
          libcxxabi = llvmImport "libcxxabi";
          libunwind = llvmImport "libunwind";
        };
        libraries = [
          {
            # Built with every symbol but the API hidden.
            name = "libibus-web";
            version = "{abi}";
            archives = [ "${runtime.libibusWeb}/lib/libibus-web.a" ];
          }
          {
            name = "ibus";
            version = "{ibus}+ibus-web.{abi}";
            archives = [ "${runtime.libibusWeb}/lib/libibus-web-ibus.a" ];
            declaredIn = {
              headers = [ "ibus.h" ];
              packages = [ "ibus-1.0" ];
              transitive = true;
            };
          }
        ]
        # GLib is built with hidden visibility too: its default-visible
        # symbols are its API.
        ++
          map
            (library: {
              name = library;
              version = "{glib}";
              archives = [ "${pkgsWasm.glib.out}/lib/lib${library}.a" ];
            })
            [
              "glib-2.0"
              "gobject-2.0"
              "gmodule-2.0"
              "gio-2.0"
            ]
        ++ [
          {
            # libffi hides only some of its internals; the rest of what it
            # leaves visible, trampoline helpers among them, its header
            # doesn't declare.
            name = "libffi";
            version = "{libffi}";
            archives = [ "${pkgsWasm.libffi.out}/lib/libffi.a" ];
            declaredIn = {
              headers = [ "ffi.h" ];
              packages = [ "libffi" ];
            };
          }
          # The IndexedDB backend, part of the runtime and versioned with
          # it. Its archive leaves its C++ internals visible; side modules
          # get its header's API alone.
          {
            name = "wasmfs-idb";
            version = "{abi}";
            archives = [ "${runtime.wasmfsIdb}/lib/libwasmfs-idb.a" ];
            declaredIn.headers = [ "ibus-web/wasmfs-idb.h" ];
          }
          # Emscripten's own API, implemented partly in C, in whichever system
          # library, and partly in JavaScript. It comes before the libraries
          # that implement it, so its names are its own.
          #
          # These eleven headers are the part of it a runtime serves. html5,
          # webgl, wget, fetch and websocket are browser APIs engines don't
          # use, and listing them would put their JavaScript in every
          # runtime; syscalls.h is out because side modules make system calls
          # only through libc. Of wasmfs.h, the OPFS backend is out: in
          # Firefox its reads of files opened read-only wait for the page's
          # main thread, and its other reads lock the file across the
          # origin, so engines' storage is the IndexedDB backend.
          #
          # Weak definitions are hooks a program overrides at its own link,
          # which a side module can't. Functions that need ASYNCIFY are stubs
          # that abort in a runtime built without it; off the list, an engine
          # that calls one fails its import check when it is built.
          {
            name = "emscripten";
            version = "{emscripten}";
            systemLibraries = "*";
            javascript.withoutAsyncify = true;
            declaredIn.headers = map (header: "emscripten/${header}.h") [
              "emscripten"
              "em_asm"
              "em_js"
              "console"
              "threading"
              "proxying"
              "eventloop"
              "heap"
              "atomic"
              "stack"
              "wasmfs"
            ];
            declaredIn.except = [ "wasmfs_create_opfs_backend" ];
            skipWeak = true;
          }
          # Emscripten's C and C++ runtime, whole: side modules link no system
          # libraries, so every libc, libc++ and compiler builtin call an
          # engine makes lands here. The rest a main module links (OpenGL,
          # OpenAL, HTML5 events) are browser APIs no engine reaches for.
          #
          # Emscripten implements part of libc in JavaScript (assert's
          # __assert_fail, exit, the resolver): its JavaScript functions that
          # musl's headers declare. Two of those headers don't compile on
          # their own: musl's sys/procfs.h needs ELF register sets, which
          # Emscripten's architecture lacks, and Emscripten's overlay of
          # sys/random.h uses size_t before anything defines it.
          {
            name = "libc";
            version = "{musl}+emscripten.{emscripten}";
            systemLibraries = [
              "c"
              "dlmalloc"
              "noexit"
              "stubs"
              "sockets"
            ];
            javascript.declaredIn = {
              tree = "${emscriptenRoot}/system/lib/libc/musl/include";
              unparseable = [
                "sys/procfs.h"
                "sys/random.h"
              ];
            };
          }
          {
            name = "compiler-rt";
            version = "{compilerRt}";
            systemLibraries = [ "clang_rt.builtins" ];
          }
          {
            name = "libc++";
            version = "{libcxx}";
            systemLibraries = [ "c++" ];
          }
          {
            name = "libc++abi";
            version = "{libcxxabi}";
            systemLibraries = [ "c++abi" ];
          }
          {
            name = "libunwind";
            version = "{libunwind}";
            systemLibraries = [ "unwind" ];
          }
        ];
      };

      exportList = pkgsWasm.stdenv.mkDerivation {
        pname = "ibus-runtime-exports";
        inherit (runtime.libibusWeb) version;
        dontUnpack = true;
        nativeBuildInputs = [
          pkgsWasm.pkg-config
          pkgs.python3
        ];
        buildInputs = [
          runtime.libibusWeb
          runtime.wasmfsIdb
          pkgsWasm.libffi
        ];
        dontFixup = true;
        # The system libraries' variants, and the C functions Emscripten's
        # JavaScript library implements, are those of a link with the
        # runtime's settings, without assertions, as it is released.
        # EMCC_DEBUG keeps the settings that link hands its JavaScript
        # compiler.
        buildPhase = ''
          runHook preBuild
          echo 'int main(void) { return 0; }' > probe.c
          $CC -c probe.c -o probe.o
          EMCC_DEBUG=1 EMCC_TEMP_DIR=$PWD $CXX ${runtime.linkFlags} probe.o -o probe.js -v 2> link.log
          python3 ${./exports.py} manifest --spec ${pkgs.writeText "ibus-runtime-exports.json" (builtins.toJSON spec)} \
            --objdump ${emscripten.llvmEnv}/bin/llvm-objdump --link-log link.log --out $out
          runHook postBuild
        '';
        dontInstall = true;
      };
    in
    {
      ibusWeb.runtime.exportList = exportList;
      ibusWeb.runtime.checkSideModuleImports =
        { name, modules }:
        pkgs.runCommand "ibus-web-${name}-side-module-imports"
          {
            nativeBuildInputs = [ pkgs.python3 ];
          }
          ''
            python3 ${./imports.py} --emscripten ${emscriptenRoot} \
              --exports ${exportList}/exports.txt ${lib.escapeShellArgs modules} | tee $out
          '';
    };
}
