# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.testing = {
      gtestCflagList = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        description = "Compile flags for a GoogleTest program's sources, one flag an element: GoogleTest's headers, with its pthread support on.";
      };
      gtestLinkFlags = lib.mkOption {
        type = lib.types.str;
        description = ''
          Link flags after a GoogleTest program's objects: main() on a pthread
          (-sPROXY_TO_PTHREAD), which runs the tests its arguments select and hands
          GoogleTest's JSON report to the shim through the harness's JavaScript library,
          and GoogleTest itself.
        '';
      };
    };
  };

  config.perSystem =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      inherit (config.ibusWeb) toolchain typescript;
      inherit (toolchain) pkgsWasm;
      inherit (config.ibusWeb.lib) libraryDeps emscriptenRoot;

      gtest = pkgsWasm.gtest;
      gtestCflagList = [
        "-I${lib.getDev gtest}/include"
        "-DGTEST_HAS_PTHREAD=1"
      ];
      gtestCflags = lib.concatStringsSep " " gtestCflagList;
      reportLibrary = ./gtest-main/report.js;

      gtestMainObject = pkgsWasm.stdenv.mkDerivation {
        name = "ibus-web-gtest-main";
        dontUnpack = true;
        dontFixup = true;
        buildPhase = ''
          runHook preBuild
          $CXX ${gtestCflags} -c ${./gtest-main/main.cpp} -o gtest-main.o
          runHook postBuild
        '';
        installPhase = ''
          runHook preInstall
          install -Dm644 -t $out gtest-main.o
          runHook postInstall
        '';
      };

      # Types for what the report library uses from Emscripten, from a link
      # that exports exactly that.
      reportTypes = config.ibusWeb.lib.emscriptenTypes {
        name = "gtest-main-types";
        library = reportLibrary;
      };

      # Where the report library's type check finds those types.
      typesDir = "emscripten-types";
    in
    {
      ibusWeb.testing = {
        inherit gtestCflagList;
        gtestLinkFlags = "-sPROXY_TO_PTHREAD=1 ${gtestMainObject}/gtest-main.o -L${lib.getLib gtest}/lib -lgtest --js-library=${reportLibrary}";
      };

      # The harness and every GoogleTest program here include GoogleTest.
      ibusWeb.toolchain.clangdPathFlags."modules/testing/.*\\.(cpp|h)" = gtestCflagList;

      ibusWeb.toolchain.emscriptenTypes.gtest-main-types = {
        link = "modules/testing/gtest-main/${typesDir}";
        package = reportTypes;
      };

      # The report library must name every Emscripten symbol it uses in its
      # __deps, and type-check against what Emscripten gives it.
      checks.gtest-main-library =
        let
          root = ../..;
          sources = lib.fileset.toSource {
            inherit root;
            fileset = lib.fileset.unions [
              ../../runtime/wasmfs-idb/src/emscripten-library.d.ts
              ./tsconfig.json
              ./gtest-main/report.js
              ./gtest-main/report.d.ts
            ];
          };
        in
        pkgs.runCommand "ibus-web-gtest-main-library-check"
          {
            nativeBuildInputs = [
              typescript.nodejs
              typescript.tsc
            ];
          }
          ''
            cp -r --no-preserve=mode ${sources} source
            cd source
            mkdir -p node_modules/@ibus-web
            cp -R ${typescript.presets} node_modules/@ibus-web/tsconfig
            node ${libraryDeps} check modules/testing/gtest-main/report.js ${emscriptenRoot}
            # The library's declarations read Emscripten's decorators from
            # the types beside them, which any library's link writes alike.
            ln -s ${reportTypes} runtime/wasmfs-idb/src/${typesDir}
            ln -s ${reportTypes} modules/testing/gtest-main/${typesDir}
            tsc -p modules/testing
            touch $out
          '';
    };
}
