# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-3.0-or-later
{
  config,
  lib,
  withSystem,
  ...
}:
let
  inherit (config.ibusWeb.lib) isEmscriptenWasm patchesIn;
in
{
  flake.overlays.rime =
    final: prev:
    lib.optionalAttrs (isEmscriptenWasm prev.stdenv.hostPlatform) (
      withSystem prev.stdenv.buildPlatform.system (
        { config, pkgs, ... }:
        let
          # A layer with no patch has no directory.
          layer =
            library: name:
            let
              dir = ./patches + "/${library}/${name}";
            in
            lib.optionals (builtins.pathExists dir) (patchesIn dir);
          patchesFor = library: layer library "port" ++ layer library "casts";
        in
        {
          leveldb = prev.leveldb.overrideAttrs (old: {
            # Snappy compresses tables Rime's are too small to gain from.
            buildInputs = [ ];
            propagatedBuildInputs = [ ];
            cmakeFlags = (old.cmakeFlags or [ ]) ++ [
              "-DHAVE_CRC32C=OFF"
              "-DHAVE_SNAPPY=OFF"
              "-DHAVE_TCMALLOC=OFF"
            ];
            doCheck = false;
          });

          opencc = prev.opencc.overrideAttrs (old: {
            patches = (old.patches or [ ]) ++ patchesFor "opencc";
            buildInputs = old.buildInputs ++ [ final.marisa ];
            postPatch = (old.postPatch or "") + ''
              substituteInPlace CMakeLists.txt --replace-fail 'add_subdirectory(data)' ""
              substituteInPlace src/CMakeLists.txt --replace-fail 'add_subdirectory(tools)' ""
            '';
            cmakeFlags = (old.cmakeFlags or [ ]) ++ [
              "-DUSE_SYSTEM_MARISA=ON"
              "-DENABLE_SEGMENTATION_PLUGINS=OFF"
              # Rime names OpenCC's configurations by path, in its shared data
              # directory. Outside the store, the library doesn't refer to its
              # own output.
              "-DSHARE_INSTALL_PREFIX=/usr/share"
              "-DBUILD_OPENCC_JIEBA_PLUGIN=OFF"
              "-DENABLE_GTEST=OFF"
              "-DENABLE_BENCHMARK=OFF"
              "-DBUILD_PYTHON=OFF"
              "-DBUILD_DOCUMENTATION=OFF"
            ];
          });

          glog = prev.glog.overrideAttrs (old: {
            buildInputs = [ ];
            propagatedBuildInputs = [ ];
            cmakeFlags = [
              "-DWITH_GFLAGS=OFF"
              "-DWITH_UNWIND=OFF"
              "-DWITH_GTEST=OFF"
              "-DBUILD_TESTING=OFF"
              "-DWITH_PKGCONFIG=ON"
            ];
            doCheck = false;
            # glog's CMake package defines this for its consumers; its
            # pkg-config file doesn't, and the headers refuse to build
            # without it.
            postInstall = (old.postInstall or "") + ''
              substituteInPlace $out/lib/pkgconfig/libglog.pc \
                --replace-fail 'Cflags: -I''${includedir}' 'Cflags: -I''${includedir} -DGLOG_USE_GLOG_EXPORT'
            '';
          });

          lua5_2_compat = prev.lua5_2_compat.overrideAttrs (old: {
            buildInputs = [ ];
            propagatedBuildInputs = [ ];
            # librime-lua sets the search path for Rime's scripts. Outside the
            # store, the library doesn't refer to its own output.
            postPatch = old.postPatch + ''
              sed -i "s@#define LUA_ROOT[[:space:]]*\"$out/\"@#define LUA_ROOT \"/usr/local/\"@" src/luaconf.h
            '';
            makeFlags = map (
              flag:
              if lib.hasPrefix "PLAT=" flag then
                "PLAT=posix"
              else if lib.hasPrefix "MYLIBS=" flag then
                "MYLIBS="
              else
                flag
            ) old.makeFlags;
          });

          librime =
            (prev.librime.override {
              boost = final.ibus-web-boost-headers;
              plugins = [
                final.librime-lua
                final.librime-octagram
              ];
            }).overrideAttrs
              (old: {
                patches = (old.patches or [ ]) ++ patchesFor "librime";
                buildInputs = [ final.ibus-web-boost-headers ];
                # A static library's consumers link its dependencies too.
                propagatedBuildInputs = with final; [
                  glog
                  leveldb
                  marisa
                  opencc
                  yaml-cpp
                  lua5_2_compat
                ];
                cmakeFlags = [
                  "-DBUILD_STATIC=ON"
                  "-DBUILD_SHARED_LIBS=OFF"
                  "-DBUILD_MERGED_PLUGINS=ON"
                  "-DBUILD_TEST=OFF"
                  "-DBUILD_TOOLS=OFF"
                  "-DENABLE_LOGGING=ON"
                  "-DENABLE_THREADING=ON"
                  # WasmFS gives a file the time it first saw it, not the
                  # store's, so recorded times never match and would make each
                  # deployment rebuild every prism. Without them the configs
                  # recompile on each deployment, to the same bytes, and the
                  # prebuilt prisms stay current.
                  "-DENABLE_TIMESTAMP=OFF"
                  "-DENABLE_EXTERNAL_PLUGINS=OFF"
                  "-DINSTALL_PRIVATE_HEADERS=ON"
                ];
                postInstall = (old.postInstall or "") + ''
                  mkdir -p $out/lib/pkgconfig
                  cat > $out/lib/pkgconfig/rime.pc <<EOF
                  Name: Rime
                  Description: Rime Input Method Engine
                  Version: ${old.version}
                  Requires.private: yaml-cpp leveldb marisa opencc libglog lua
                  Cflags: -I$out/include
                  Libs: -L$out/lib -lrime
                  EOF
                '';
              });

          ibus-web-rime-tools = final.stdenv.mkDerivation {
            pname = "ibus-web-rime-tools";
            inherit (final.librime) version src;
            nativeBuildInputs = [ final.buildPackages.pkg-config ];
            buildInputs = [
              final.librime
              final.ibus-web-boost-headers
            ];
            dontConfigure = true;
            buildPhase = ''
              runHook preBuild
              for tool in rime_deployer rime_dict_manager; do
                $CXX -std=c++17 -Itools $($PKG_CONFIG --cflags rime libglog yaml-cpp leveldb marisa opencc) -c tools/$tool.cc -o $tool.o
                $CXX ${config.ibusWeb.toolchain.testMainFlags} -sINITIAL_MEMORY=2GB -sSTACK_SIZE=1MB -sDEFAULT_PTHREAD_STACK_SIZE=1MB \
                  $tool.o $($PKG_CONFIG --static --libs rime) -o $tool.js
              done
              runHook postBuild
            '';
            installPhase = ''
              runHook preInstall
              install -Dm644 -t $out rime_deployer.js rime_dict_manager.js
              runHook postInstall
            '';
            dontFixup = true;
          };

          # Built apart from rime.wasm, so that what rime.wasm compiles in can
          # come from what it prints.
          ibus-web-rime-descriptor-program = final.stdenv.mkDerivation {
            pname = "ibus-web-rime-descriptor-program";
            inherit (final.librime) version;
            src = ./descriptors;
            nativeBuildInputs = [ final.buildPackages.pkg-config ];
            buildInputs = [ final.librime ];
            dontConfigure = true;
            buildPhase = ''
              runHook preBuild
              $CXX -std=c++17 $($PKG_CONFIG --cflags rime) -c descriptors.cc -o descriptors.o
              $CXX ${toString config.ibusWeb.lib.testLinkFlagsWithoutNodeFs} -sSTACK_SIZE=1MB -sDEFAULT_PTHREAD_STACK_SIZE=1MB \
                descriptors.o $($PKG_CONFIG --static --libs rime) -o descriptors.js
              runHook postBuild
            '';
            installPhase = ''
              runHook preInstall
              install -Dm644 -t $out descriptors.js
              runHook postInstall
            '';
            dontFixup = true;
          };

          # ibus-rime's engine, compiled with its CMake build's flags. Its
          # program, rime_main.c, connects to the bus, so the side module
          # takes only the engine and the settings it reads.
          ibus-engines = prev.ibus-engines // {
            rime = prev.ibus-engines.rime.overrideAttrs (old: {
              patches = (old.patches or [ ]) ++ patchesFor "ibus-rime";

              nativeBuildInputs = with final.buildPackages; [
                cmake
                pkg-config
              ];
              buildInputs = [
                final.libibus-web
                final.librime
              ];
              propagatedBuildInputs = [ ];

              # Rime's data directories are the module's traits; icons are
              # paths no page loads. Outside the store, neither makes the
              # module refer to this output.
              cmakeFlags = [
                "-DENABLE_LIBNOTIFY=OFF"
                "-DRIME_DATA_DIR=/usr/share/rime-data"
                "-DCMAKE_INSTALL_DATADIR=/usr/share"
              ];

              buildPhase = ''
                runHook preBuild
                # The flags as make holds them, quoted for the shell that runs
                # the compile command it writes.
                make -s -f CMakeFiles/ibus-engine-rime.dir/flags.make -f - print-cflags > cflags \
                  <<< 'print-cflags: ; $(info $(C_DEFINES) $(C_INCLUDES) $(C_FLAGS))@:'
                for source in rime_engine rime_settings; do
                  eval "$CC $(< cflags) -c ../$source.c -o $source.o"
                done
                runHook postBuild
              '';

              installPhase = ''
                runHook preInstall
                install -Dm644 -t $out/lib/ibus-rime rime_engine.o rime_settings.o cflags
                install -Dm644 -t $out/include/ibus-rime rime_config.h ../rime_engine.h ../rime_settings.h
                install -Dm644 -t $out/share/rime-data ../ibus_rime.yaml
                runHook postInstall
              '';

              postInstall = "";
              dontFixup = true;
            });
          };

          # The data and its deployment, with the descriptors made from it.
          ibus-web-rime-data = final.callPackage ./_data.nix {
            inherit (config.ibusWeb.typescript) nodejs;
            inherit (pkgs) rime-data rime-ice;
            opencc-data = pkgs.opencc;
          };

          ibus-web-rime = final.callPackage ./_package.nix {
            inherit (config.ibusWeb.toolchain) sideModuleFlags;
            inherit (config.ibusWeb.runtime) sideModuleLibraryGuard;
          };

          # CanCLID's loengfan, which rime-data's jyut6ping3 looks characters
          # up by, at the revision Debian's and Arch's packages ship.
          rime-loengfan = pkgs.stdenvNoCC.mkDerivation {
            pname = "rime-loengfan";
            version = "0-unstable-2022-03-03";
            src = pkgs.fetchFromGitHub {
              owner = "CanCLID";
              repo = "rime-loengfan";
              rev = "987ac95b02f957e8764a2f45222a4006c188ed50";
              hash = "sha256-vOqVSwKZ+p5Wc03pRUWxCdWBdxuTe8n4xu2BTbj9/b4=";
            };
            installPhase = ''
              runHook preInstall
              install -Dm644 -t $out/share/rime-data loengfan.schema.yaml loengfan.dict.yaml
              install -Dm644 -t $out/share/doc/rime-loengfan LICENSE
              runHook postInstall
            '';
            meta.license = lib.licenses.cc-by-40;
          };

          ibus-web-boost-headers = pkgs.runCommand "ibus-web-boost-headers-${pkgs.boost.version}" { } ''
            mkdir -p $out/lib/cmake
            cp -r ${pkgs.boost.dev}/include $out/include
            cp -r ${pkgs.boost.dev}/lib/cmake/{Boost,boost_headers}-${pkgs.boost.version} $out/lib/cmake/
          '';
        }
      )
    );
}
