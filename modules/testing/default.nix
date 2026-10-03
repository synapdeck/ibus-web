# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.testing = {
      playwright = {
        chromiumSandbox = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = ''
            Whether Chromium runs with its own sandbox, as a browser does, which env passes on
            to the harnesses. It needs unprivileged user namespaces, which the Nix build
            sandbox allows on Linux unless the builder forbids them; on such a builder, set it
            to false.
          '';
        };
        browsers = lib.mkOption {
          type = lib.types.package;
          description = "The browsers the workspace's playwright package drives, headless: nixpkgs' playwright-driver builds of Chromium's headless shell and Firefox.";
        };
        env = lib.mkOption {
          type = lib.types.attrsOf lib.types.str;
          description = "Environment variables under which the workspace's playwright package launches those browsers offline, as a derivation's attributes or exported in a shell, and IBUS_WEB_CHROMIUM_SANDBOX (1 or 0) for the harnesses.";
        };
        setup = lib.mkOption {
          type = lib.types.lines;
          description = "Shell commands a Nix build runs before launching the browsers. For builds only: it points HOME at a fresh directory.";
        };
      };
      browserLinkFlags = lib.mkOption {
        type = lib.types.str;
        description = "Link flags for a C or C++ test program that runs in a browser: an ES module whose factory a dedicated Worker calls, with assertions on.";
      };
      nodeLinkFlags = lib.mkOption {
        type = lib.types.str;
        description = "Link flags for a C or C++ test program that runs under Node, as `node NAME.js`: on WasmFS with the host's files at their own paths, with assertions on.";
      };
      gtestMain = lib.mkOption {
        type = lib.types.attrsOf lib.types.str;
        description = ''
          What a GoogleTest program builds with, beside browserLinkFlags or nodeLinkFlags:

          - cflags: compile flags for its sources, GoogleTest's headers.
          - libs: link flags after its objects: main() on a pthread
            (-sPROXY_TO_PTHREAD), which runs the tests its arguments select and hands
            GoogleTest's JSON report to the shim, and GoogleTest itself.
          - jsLibrary: the JavaScript library through which main() hands over the
            report, which libs already links.
        '';
      };
      gtestCflagList = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        description = "gtestMain.cflags as a list, one flag an element, for the editor's flags.";
      };
      programs = lib.mkOption {
        type = lib.types.functionTo lib.types.package;
        description = ''
          A function making a check that runs test programs with Vitest, taking:

          - name: a name for the check.
          - programs: derivations, each holding one program as NAME.js and NAME.wasm, and
            optionally NAME.args, its arguments one per line, with
            `passthru.testProgram = { name = NAME; format = "gtest-json" or "tap"; }`. A
            GoogleTest program links with gtestMain and reports through it; a TAP program
            takes g_test's -l, -s and --keep-going and prints TAP on its stdout.
            Programs for browsers link with browserLinkFlags, programs for Node with
            nodeLinkFlags.
          - environments (default chromium and firefox): where they run, any of node,
            chromium and firefox.
          - timeout (default 120): the whole seconds each program has to exit, in each
            environment.
          - expectedResults (default null): for the shim's own check. When given, as
            `{ ENVIRONMENT = [ { path = [ PROGRAM SUITE... TEST ]; status = "passed",
            "failed" or "skipped"; durationMs = [ MIN MAX ]; } ... ]; }` (durationMs
            optional), the check passes if Vitest reports exactly those tests, at those
            paths, with those results and times, instead of when every test passes.
          - vitestArgs (default none): more arguments for Vitest, such as `-t PATTERN` to
            run only the cases it names.

          Under a suite named after the environment, each program is a suite holding the
          suites and cases it lists (GoogleTest's --gtest_list_tests, g_test's -l), nested
          as it names them (GoogleTest's suites, the segments of a g_test path, TAP
          subtests), and last a test named "run". The program runs once, for the cases
          Vitest selects (--gtest_filter, or g_test's -s for the others), and each case's
          test takes the program's result and time for it; a listed case it didn't report
          fails. "run" fails when the run went wrong as a whole: the listing failed, the
          program didn't exit, its report was broken, it ran cases it wasn't asked to, or
          it exited with a failure no failing case explains. A program's output is shown
          for its failing tests. In browsers each program runs in a dedicated Worker on a
          cross-origin isolated page. Programs named PREFIX.1, PREFIX.2 and so on run in
          that order and share their storage (the origin's IndexedDB, or under Node the
          working directory), and stop at the first that fails; every other program
          starts with that storage empty. When Vitest selects cases of a later program of
          a sequence only, the earlier ones still run first, in full, for the storage
          they leave. A program's "run" test selected without any of its cases passes
          without running the program.
        '';
      };
    };
  };

  config.perSystem =
    {
      config,
      lib,
      pkgs,
      system,
      ...
    }:
    let
      inherit (config.ibusWeb) toolchain typescript;
      inherit (config.ibusWeb.testing) playwright;
      inherit (toolchain) emscripten pkgsWasm;
      # Headless Chromium runs as its headless shell, so the full browser,
      # WebKit and ffmpeg (for recording video) stay out of the closure.
      browsers = pkgs.playwright-driver.browsers.override {
        withChromium = false;
        withWebkit = false;
        withFfmpeg = false;
      };

      allEnvironments = [
        "node"
        "chromium"
        "firefox"
      ];
      formats = [
        "gtest-json"
        "tap"
      ];

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

      # Run from the workspace, where its dependencies are installed.
      libraryDeps = "${typescript.workspace}/runtime/wasmfs-idb/library-deps.ts";

      # Types for what the report library uses from Emscripten, from a link
      # that exports exactly that.
      reportTypes = pkgsWasm.stdenv.mkDerivation {
        name = "ibus-web-gtest-main-types";
        dontUnpack = true;
        nativeBuildInputs = [
          typescript.nodejs
          typescript.tsc
        ];
        dontFixup = true;
        buildPhase = ''
          runHook preBuild
          node ${libraryDeps} emit ${reportLibrary} ${emscripten}/share/emscripten $out
          $CXX -sASSERTIONS=1 --no-entry --js-library=${reportLibrary} \
            -sEXPORTED_RUNTIME_METHODS=$(cat $out/exported-runtime-methods.txt) \
            -sEXPORTED_FUNCTIONS=$(cat $out/exported-functions.txt) \
            --emit-tsd $out/emscripten.d.ts -o probe.js
          runHook postBuild
        '';
        dontInstall = true;
      };

      # Where the report library's type check finds those types.
      typesDir = "emscripten-types";

      packageDir = "${typescript.workspace}/packages/test-programs";

      # Vitest exits non-zero when a test fails, which the shim's own check
      # expects, so its verdict comes from the JSON report instead.
      runVitest =
        {
          name,
          manifest,
          limit,
          inBrowsers,
          expectedResults,
          vitestArgs ? [ ],
        }:
        pkgs.runCommand "ibus-web-test-programs-${name}"
          (
            {
              nativeBuildInputs = [ typescript.nodejs ];
              IBUS_WEB_TEST_PROGRAMS = manifest;
              # Nix gives a build a terminal, on which Vitest would redraw its
              # progress into the log, over and over.
              CI = "1";
            }
            // lib.optionalAttrs inBrowsers playwright.env
          )
          ''
            ${if inBrowsers then playwright.setup else "export HOME=$(mktemp -d)"}
            export IBUS_WEB_TEST_CACHE_DIR=$TMPDIR/vite
            mkdir $out
            status=0
            (
              cd ${packageDir}
              timeout --kill-after=10 ${limit} \
                node node_modules/vitest/vitest.mjs run --configLoader native \
                  --reporter=default --reporter=json --outputFile.json=$out/results.json \
                  ${lib.escapeShellArgs vitestArgs}
            ) || status=$?
            ${
              if expectedResults == null then
                ''exit "$status"''
              else
                ''
                  node ${./expect-results.ts} $out/results.json ${pkgs.writeText "expected-results.json" (builtins.toJSON expectedResults)}
                ''
            }
          '';

      programs =
        {
          name,
          programs,
          environments ? [
            "chromium"
            "firefox"
          ],
          timeout ? 120,
          expectedResults ? null,
          vitestArgs ? [ ],
        }:
        let
          entry =
            program:
            let
              testProgram =
                program.passthru.testProgram
                  or (throw "programs ${name}: ${program.name} has no passthru.testProgram");
            in
            assert lib.assertMsg (lib.elem testProgram.format formats)
              "programs ${name}: ${testProgram.name}'s format is ${builtins.toJSON testProgram.format}, not one of ${toString formats}";
            {
              inherit (testProgram) name format;
              dir = "${program}";
            };
          manifest = pkgs.writeText "ibus-web-test-programs-${name}.json" (
            builtins.toJSON {
              inherit timeout environments;
              programs = map entry programs;
            }
          );
        in
        assert lib.assertMsg (
          lib.isInt timeout && timeout > 0
        ) "programs ${name}: timeout is whole seconds, a positive integer, not ${builtins.toJSON timeout}";
        assert lib.assertMsg
          (environments != [ ] && lib.all (environment: lib.elem environment allEnvironments) environments)
          "programs ${name}: environments must be some of ${toString allEnvironments}, not ${toString environments}";
        runVitest {
          inherit
            name
            manifest
            expectedResults
            vitestArgs
            ;
          inBrowsers = environments != [ "node" ];
          # Vitest holds each program to its own limit; this one, past every
          # program's in every environment, catches a browser or Vitest that
          # hangs outright.
          limit = toString ((timeout + 60) * builtins.length environments * builtins.length programs + 300);
        };
    in
    {
      ibusWeb.testing = {
        playwright = {
          inherit browsers;
          env = {
            PLAYWRIGHT_BROWSERS_PATH = "${browsers}";
            PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
            # Playwright checks the host's distribution packages for the
            # browsers' libraries; Nix links them in instead.
            PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "1";
            IBUS_WEB_CHROMIUM_SANDBOX = if playwright.chromiumSandbox then "1" else "0";
          };
          # Firefox writes to its XDG configuration and data directories under
          # HOME as it starts, even with the fresh profile Playwright gives
          # it, and hangs before Playwright can connect if it can't; a build's
          # HOME doesn't exist.
          setup = ''
            export HOME=$(mktemp -d)
          '';
        };

        browserLinkFlags = "-sASSERTIONS=1 -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=worker -sEXIT_RUNTIME=1";

        # A program on its own needs nothing of a main module's.
        nodeLinkFlags = lib.concatStringsSep " " (
          lib.filter (flag: !lib.hasPrefix "-sMAIN_MODULE" flag) toolchain.testMainFlagList
        );

        gtestMain = {
          cflags = gtestCflags;
          libs = "-sPROXY_TO_PTHREAD=1 ${gtestMainObject}/gtest-main.o -L${lib.getLib gtest}/lib -lgtest --js-library=${reportLibrary}";
          jsLibrary = "${reportLibrary}";
        };

        inherit gtestCflagList programs;
      };

      # The harness and every GoogleTest program here include GoogleTest.
      ibusWeb.toolchain.clangdPathFlags."modules/testing/.*\\.(cpp|h)" = gtestCflagList;

      packages.gtest-main-types = reportTypes;

      # The report library must name every Emscripten symbol it uses in its
      # __deps, and type-check against what Emscripten gives it.
      checks.gtest-main-library =
        let
          root = ../..;
          sources = lib.fileset.toSource {
            inherit root;
            fileset = lib.fileset.unions [
              ../../tsconfig.base.json
              ../../runtime/wasmfs-idb/src/emscripten-library.d.ts
              ./gtest-main/tsconfig.json
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
            node ${libraryDeps} check modules/testing/gtest-main/report.js ${emscripten}/share/emscripten
            # The library's declarations read Emscripten's decorators from
            # the types beside them, which any library's link writes alike.
            ln -s ${reportTypes} runtime/wasmfs-idb/src/${typesDir}
            ln -s ${reportTypes} modules/testing/gtest-main/${typesDir}
            tsc -p modules/testing/gtest-main
            touch $out
          '';

      # Built when the shell starts rather than as part of it, so the shell
      # still enters while the library doesn't build. The out-link keeps the
      # types from garbage collection.
      devshells.default.devshell.startup.gtest-main-types.text = ''
        rm -f "$FLAKE_ROOT/modules/testing/gtest-main/${typesDir}"
        nix build "$FLAKE_ROOT#packages.${system}.gtest-main-types" \
          --out-link "$FLAKE_ROOT/modules/testing/gtest-main/${typesDir}" ||
          echo "gtest-main types unavailable" >&2
      '';
    };
}
