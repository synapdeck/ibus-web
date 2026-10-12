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

          lua = prev.lua.overrideAttrs (old: {
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
                  lua
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
              install -Dm644 -t $out rime_deployer.{js,wasm} rime_dict_manager.{js,wasm}
              runHook postInstall
            '';
            dontFixup = true;
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
