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

      # The header defines the ABI version.
      abi =
        let
          versions = lib.concatMap (
            line:
            let
              m = builtins.match "#define IBUSWEB_RUNTIME_ABI ([0-9]+)" line;
            in
            lib.optional (m != null) (lib.toInt (builtins.head m))
          ) (lib.splitString "\n" (builtins.readFile "${runtime.libibusWeb.src}/include/ibus-web/runtime.h"));
        in
        assert lib.length versions == 1;
        builtins.head versions;

      # The libraries the runtime carries for side modules, besides the C and
      # C++ runtime.
      libraries = [
        "${runtime.libibusWeb}/lib/libibus-web.a"
        "${pkgsWasm.glib.out}/lib/libglib-2.0.a"
        "${pkgsWasm.glib.out}/lib/libgobject-2.0.a"
        "${pkgsWasm.glib.out}/lib/libgmodule-2.0.a"
        "${pkgsWasm.glib.out}/lib/libgio-2.0.a"
        "${pkgsWasm.libffi.out}/lib/libffi.a"
      ];

      # Emscripten's system libraries that make up the C and C++ runtime:
      # libc with its allocator, compiler builtins, exit handling and stubs,
      # the file system and sockets, libc++, libc++abi and the unwinder. The
      # rest a main module links (OpenGL, OpenAL, HTML5 events) are browser
      # APIs no engine reaches for.
      cRuntime = [
        "c"
        "dlmalloc"
        "clang_rt.builtins"
        "noexit"
        "stubs"
        "wasmfs"
        "sockets"
        "c++"
        "c++abi"
        "unwind"
      ];

      exportList =
        pkgs.runCommand "ibus-runtime-exports"
          {
            nativeBuildInputs = [
              emscripten
              toolchain.emscriptenCacheHook
              pkgs.python3
            ];
            passthru = { inherit abi; };
          }
          ''
            # The system libraries' variants are those of a link with the
            # runtime's settings, without assertions, as it is released.
            echo 'int main(void) { return 0; }' > probe.c
            em++ ${toolchain.commonFlags} ${toolchain.runtimeMainFlags} -x c probe.c -o probe.js -v 2> link.log
            mkdir $out
            python3 ${./exports.py} --abi ${toString abi} \
              --objdump ${emscripten.llvmEnv}/bin/llvm-objdump --link-log link.log \
              ${lib.concatMapStringsSep " " (l: "--system-library ${l}") cRuntime} \
              ${lib.escapeShellArgs libraries} > $out/exports.txt
          '';
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
            python3 ${./imports.py} --emscripten ${emscripten}/share/emscripten \
              --exports ${exportList}/exports.txt ${lib.escapeShellArgs modules} > $out
            cat $out
          '';
    };
}
