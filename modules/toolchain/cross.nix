{ inputs, config, ... }:
let
  flakeOverlays = builtins.attrValues config.flake.overlays;
in
{
  perSystem =
    {
      config,
      lib,
      system,
      ...
    }:
    let
      inherit (config.ibusWeb) toolchain;

      replaceCrossStdenv =
        { buildPackages, baseStdenv }:
        let
          # buildPackages (pkgsBuildHost) gives Emscripten a WASM target
          # platform, which rehashes it and everything under it, openjdk
          # included, so none of it comes from the binary cache.
          pkgsBuildBuild = buildPackages.buildPackages;
          inherit (pkgsBuildBuild) emscripten;

          # cc-wrapper keys clang feature checks off the compiler's version,
          # which here is the clang Emscripten was built against.
          clangVersion = lib.getVersion (
            builtins.unsafeDiscardStringContext (baseNameOf (builtins.head emscripten.llvmEnv.paths))
          );

          # cc-wrapper wraps a clang-shaped compiler; emcc and em++ take the
          # clang and clang++ roles.
          emscriptenClang =
            pkgsBuildBuild.runCommand "emscripten-clang-${emscripten.version}"
              {
                # Overlays check isEmscripten so their Emscripten-specific
                # changes never reach a native or WASI package set.
                passthru = {
                  isClang = true;
                  isEmscripten = true;
                  version = clangVersion;
                  langC = true;
                  langCC = true;
                };
              }
              ''
                mkdir -p $out/bin
                ln -s ${emscripten}/bin/emcc $out/bin/clang
                ln -s ${emscripten}/bin/em++ $out/bin/clang++
                ln -s ${emscripten}/bin/emcc $out/bin/cc
                ln -s ${emscripten}/bin/em++ $out/bin/c++
              '';

          emscriptenBinutils = pkgsBuildBuild.runCommand "emscripten-binutils-${emscripten.version}" { } ''
            mkdir -p $out/bin
            ln -s ${emscripten}/bin/emar $out/bin/ar
            ln -s ${emscripten}/bin/emranlib $out/bin/ranlib
            for tool in nm strip objdump objcopy readelf size strings; do
              ln -s ${emscripten.llvmEnv}/bin/llvm-$tool $out/bin/$tool
            done
            ln -s ${emscripten.llvmEnv}/bin/wasm-ld $out/bin/ld
          '';

          bintools = buildPackages.wrapBintoolsWith {
            bintools = emscriptenBinutils;
            # Emscripten's libc lives in its cache sysroot, which emcc adds
            # to every command itself; a libc here would put a second set of
            # headers and libraries on the command line.
            libc = null;
            # The default list targets native ELF toolchains (relro, bindnow,
            # stack clash protection, zeroed call-used registers), several of
            # which clang rejects for wasm32-unknown-emscripten.
            defaultHardeningFlags = [
              "format"
              "pic"
              "strictflexarrays1"
            ];
          };

          cc = buildPackages.wrapCCWith {
            cc = emscriptenClang;
            inherit bintools;
            libc = null;
            isClang = true;
            # emcc picks its own target and adds its sysroot's include paths,
            # so the wrapper's --target and -nostdlibinc (meant to hide
            # /usr/include) would only fight it.
            extraBuildCommands = ''
              rm -f $out/nix-support/add-local-cc-cflags-before.sh
              sed -i '/-nostdlibinc/d' $out/nix-support/cc-cflags
              echo "${toolchain.commonFlags}" >> $out/nix-support/cc-cflags
              cp ${./emscripten-cc-wrapper-hook.sh} $out/nix-support/cc-wrapper-hook
            '';
          };
        in
        buildPackages.stdenvAdapters.makeStaticLibraries (
          baseStdenv.override (old: {
            inherit cc;
            extraNativeBuildInputs = old.extraNativeBuildInputs ++ [ toolchain.emscriptenCacheHook ];
          })
        );
    in
    let
      pkgsWasm = import inputs.nixpkgs {
        localSystem = system;
        # Side modules link their libraries statically, so every recipe
        # builds static libraries only.
        crossSystem = lib.systems.examples.wasm32-unknown-none // {
          isStatic = true;
        };
        overlays = flakeOverlays;
        config = {
          # Recipes' platform lists predate this target; building them for
          # it is the point.
          allowUnsupportedSystem = true;
          inherit replaceCrossStdenv;
        };
      };
    in
    {
      ibusWeb.toolchain.pkgsWasm = pkgsWasm;
      legacyPackages.pkgsWasm = pkgsWasm;
    };
}
