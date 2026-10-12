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
        { pkgs, ... }:
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

          ibus-web-boost-headers = pkgs.runCommand "ibus-web-boost-headers-${pkgs.boost.version}" { } ''
            mkdir -p $out/lib/cmake
            cp -r ${pkgs.boost.dev}/include $out/include
            cp -r ${pkgs.boost.dev}/lib/cmake/{Boost,boost_headers}-${pkgs.boost.version} $out/lib/cmake/
          '';
        }
      )
    );
}
