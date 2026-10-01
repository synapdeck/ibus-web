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
      # comes from in that library's README.
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
          # Emscripten's C and C++ runtime, whole: side modules link no system
          # libraries, so every libc, libc++ and compiler builtin call an
          # engine makes lands here. The rest a main module links (OpenGL,
          # OpenAL, HTML5 events) are browser APIs no engine reaches for.
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
          {
            # WasmFS leaves its C++ internals visible; only what Emscripten's
            # headers declare is its API. Weak definitions are hooks a
            # program overrides at its own link, which a side module can't.
            name = "emscripten";
            version = "{emscripten}";
            systemLibraries = [ "wasmfs" ];
            declaredIn.beside = "emscripten/emscripten.h";
            skipWeak = true;
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
          pkgsWasm.libffi
        ];
        dontFixup = true;
        # The system libraries' variants are those of a link with the
        # runtime's settings, without assertions, as it is released.
        buildPhase = ''
          runHook preBuild
          echo 'int main(void) { return 0; }' > probe.c
          $CC -c probe.c -o probe.o
          $CXX ${runtime.linkFlags} probe.o -o probe.js -v 2> link.log
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
