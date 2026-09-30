{ inputs, config, ... }:
let
  flakeOverlays = builtins.attrValues config.flake.overlays;
in
{
  perSystem =
    {
      config,
      lib,
      pkgs,
      system,
      ...
    }:
    let
      inherit (config.ibusWeb) toolchain;

      # Meson keys Emscripten behaviour (GLib's patches, the .js executable
      # suffix) on the host system, which nixpkgs' cross file reports as the
      # platform's kernel, "none". Node runs what Emscripten links, so Meson
      # can run tests and run() checks.
      mesonCrossFile = pkgs.writeText "emscripten-meson-cross.ini" ''
        [host_machine]
        system = 'emscripten'

        [binaries]
        exe_wrapper = ['${lib.getExe pkgs.nodejs}']
      '';

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
                passthru = {
                  isClang = true;
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

          # The bintools wrapper only wraps tools carrying the target prefix;
          # unprefixed ones leave $AR and friends unset, and builds fall back
          # to whatever `ar` is on PATH.
          targetPrefix = "${baseStdenv.hostPlatform.config}-";
          emscriptenBinutils = pkgsBuildBuild.runCommand "emscripten-binutils-${emscripten.version}" { } ''
            mkdir -p $out/bin
            ln -s ${emscripten}/bin/emar $out/bin/${targetPrefix}ar
            ln -s ${emscripten}/bin/emranlib $out/bin/${targetPrefix}ranlib
            for tool in nm strip objdump objcopy readelf size strings; do
              ln -s ${emscripten.llvmEnv}/bin/llvm-$tool $out/bin/${targetPrefix}$tool
            done
            ln -s ${emscripten.llvmEnv}/bin/wasm-ld $out/bin/${targetPrefix}ld
          '';

          emscriptenMesonHook = pkgsBuildBuild.makeSetupHook {
            name = "emscripten-meson-hook";
            substitutions.crossFile = mesonCrossFile;
          } ./emscripten-meson-hook.sh;

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
              test -e $out/nix-support/add-local-cc-cflags-before.sh
              rm $out/nix-support/add-local-cc-cflags-before.sh
              grep -q -- -nostdlibinc $out/nix-support/cc-cflags
              sed -i '/-nostdlibinc/d' $out/nix-support/cc-cflags
              # cc-cflags follow the command's own arguments, where an
              # optimization level would override the package's; before
              # them, a package's own -O still wins.
              for flag in ${toolchain.commonFlags}; do
                case "$flag" in
                  -O*) echo "$flag" >> $out/nix-support/cc-cflags-before ;;
                  *) echo "$flag" >> $out/nix-support/cc-cflags ;;
                esac
              done
              cp ${./emscripten-cc-wrapper-hook.sh} $out/nix-support/cc-wrapper-hook
            '';
          };
        in
        # The frozen cache is built from the perSystem Emscripten; a different
        # one would leave the wrapper's emcc with a stale cache.
        assert emscripten.drvPath == pkgs.emscripten.drvPath;
        baseStdenv.override (old: {
          inherit cc;
          extraNativeBuildInputs = old.extraNativeBuildInputs ++ [
            toolchain.emscriptenCacheHook
            emscriptenMesonHook
          ];
        });

      pkgsWasm = import inputs.nixpkgs {
        localSystem = system;
        crossSystem = lib.systems.examples.wasm32-unknown-none // {
          # Side modules link their libraries statically; nixpkgs' makeStatic
          # adapter makes every recipe build static libraries only.
          isStatic = true;
          # Overlays gate on this because the platform can be read without
          # evaluating the compiler.
          useEmscripten = true;
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
      # nixpkgs' generated cross file first, then ours, the order builds see.
      ibusWeb.toolchain.mesonCrossFlags =
        (import "${inputs.nixpkgs}/pkgs/build-support/lib/meson.nix" {
          inherit lib;
          inherit (pkgsWasm) stdenv;
        }).makeMesonFlags
          { }
        ++ [ "--cross-file=${mesonCrossFile}" ];
      legacyPackages.pkgsWasm = pkgsWasm;
    };
}
