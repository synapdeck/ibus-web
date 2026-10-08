# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.testing = {
      browserLinkFlags = lib.mkOption {
        type = lib.types.str;
        description = "Link flags for a C or C++ test program that runs in a browser: an ES module whose factory a dedicated Worker calls, with assertions on.";
      };

      nodeLinkFlags = lib.mkOption {
        type = lib.types.str;
        description = "Link flags for a C or C++ test program that runs under Node, as `node NAME.js`: on WasmFS with the host's files at their own paths, with assertions on.";
      };

      program = lib.mkOption {
        type = lib.types.functionTo lib.types.package;
        description = ''
          A function building one test program for programs, taking:

          - name: the program's name; the derivation holds NAME.js and NAME.wasm.
          - src: the directory its sources are in. The build sees the sources it
            compiles, the .h files in src, and extraSources.
          - sources (default [ "NAME.cpp" ]): the files to compile, relative to src; .c
            files with $CC, the rest with $CXX.
          - extraSources (default none): more files from src the build reads, such as
            ones preBuild compiles.
          - format (default "gtest-json"): its passthru.testProgram format, "gtest-json"
            or "tap", or null for a program that programs doesn't run, which then has
            no passthru.testProgram.
          - gtest (default: format is "gtest-json"): whether it compiles with
            gtestCflagList and links gtestLinkFlags.
          - linkFlags (required), cflags and libs (default none): shell words, as
            strings or lists, for the link before the objects, for compiling each
            source, and for the link after the objects, before gtestLinkFlags.
            The build's shell expands them, so they may name $out.
          - args (default null): its arguments, as a list, written to NAME.args.
          - preBuild (default none): shell commands run before compiling, with $out
            already made, for whatever else the program needs beside it.
          - nativeBuildInputs, buildInputs (default none): as for mkDerivation.
          - derivationName (default "ibus-web-test-program-NAME"): the derivation's name.

          It builds with pkgsWasm's stdenv, whose compilers add the common flags.
        '';
      };

      programs = lib.mkOption {
        type = lib.types.functionTo lib.types.package;
        description = ''
          A function making a check that runs test programs with Vitest, taking:

          - name: a name for the check.
          - programs: derivations, each holding one program as NAME.js and NAME.wasm, and
            optionally NAME.args, its arguments one per line, with
            `passthru.testProgram = { name = NAME; format = "gtest-json" or "tap"; }`. A
            GoogleTest program links with gtestLinkFlags and reports through its harness;
            a TAP program takes g_test's -l, -s and --keep-going and prints TAP on its
            stdout. Programs for browsers link with browserLinkFlags, programs for Node
            with nodeLinkFlags. It may be empty when nodeTests holds the tests.
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
          - nodeTests (default null): a directory of Vitest test files, TypeScript, that
            run in the node environment beside the programs, for what a program can't
            report on itself, such as the status it exits with. Its .ts files are copied
            as they are, so the tests keep their names and can import sibling
            helpers; every *.test.ts among them runs. They import from vitest, and read
            nodeTestData with `nodeTestData(KEY)` from
            `@ibus-web/test-programs/node-tests`, both of which resolve from the shim's
            package wherever the files are.
          - nodeTestData (default empty): strings for the nodeTests, such as the paths of
            what they run.

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
          a sequence, the earlier ones still run first for the storage they leave: in full
          when none of their cases is selected, otherwise filtered to those. A program's
          "run" test selected without any of its cases passes without running the
          program.
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
      inherit (config.ibusWeb.testing) vitestCheck gtestCflags;
      inherit (toolchain) pkgsWasm;

      allEnvironments = [
        "node"
        "chromium"
        "firefox"
      ];

      formats = [
        "gtest-json"
        "tap"
      ];

      gtestLibs = config.ibusWeb.testing.gtestLinkFlags;

      words = value: if lib.isList value then lib.concatStringsSep " " value else value;

      program =
        {
          name,
          src,
          sources ? [ "${name}.cpp" ],
          extraSources ? [ ],
          format ? "gtest-json",
          gtest ? format == "gtest-json",
          cflags ? "",
          linkFlags,
          libs ? "",
          args ? null,
          preBuild ? "",
          nativeBuildInputs ? [ ],
          buildInputs ? [ ],
          derivationName ? "ibus-web-test-program-${name}",
        }:
        assert lib.assertMsg (
          format == null || lib.elem format formats
        ) "program ${name}: format is ${builtins.toJSON format}, not null or one of ${toString formats}";
        let
          object = source: "${lib.removeSuffix ".c" (lib.removeSuffix ".cpp" source)}.o";
          compiler = source: if lib.hasSuffix ".c" source then "$CC" else "$CXX";
        in
        pkgsWasm.stdenv.mkDerivation {
          name = derivationName;
          src = lib.fileset.toSource {
            root = src;
            fileset = lib.fileset.unions (
              map (file: src + "/${file}") (sources ++ extraSources)
              ++ [ (lib.fileset.fileFilter (file: file.hasExt "h") src) ]
            );
          };

          inherit nativeBuildInputs buildInputs;
          dontFixup = true;

          buildPhase = ''
            mkdir -p $out
            runHook preBuild

            ${lib.concatMapStrings (source: ''
              ${compiler source} ${lib.optionalString gtest gtestCflags} ${words cflags} -c ${source} -o ${object source}
            '') sources}

            $CXX ${words linkFlags} ${lib.concatMapStringsSep " " object sources} ${words libs} \
              ${lib.optionalString gtest gtestLibs} -o ${name}.js

            runHook postBuild
          '';

          inherit preBuild;

          installPhase = ''
            runHook preInstall
            install -Dm644 -t $out ${name}.js ${name}.wasm

            ${lib.optionalString (args != null)
              "cp ${
                pkgs.writeText "ibus-web-test-program-${name}.args" (lib.concatMapStrings (arg: "${arg}\n") args)
              } $out/${name}.args"
            }

            runHook postInstall
          '';

          passthru = lib.optionalAttrs (format != null) {
            testProgram = { inherit name format; };
          };
        };

      packageDir = "${typescript.workspace}/packages/test-programs";

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
          nodeTests ? null,
          nodeTestData ? { },
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

          nodeTestSources = lib.fileset.toSource {
            root = nodeTests;
            # A tsconfig.json beside them would extend configurations left
            # behind, which Vite reads when it compiles them.
            fileset = lib.fileset.fileFilter (file: file.hasExt "ts") nodeTests;
          };

          nodeTestFiles = lib.optionals (nodeTests != null) (
            lib.fileset.toList (lib.fileset.fileFilter (file: lib.hasSuffix ".test.ts" file.name) nodeTests)
          );

          manifest = pkgs.writeText "ibus-web-test-programs-${name}.json" (
            builtins.toJSON (
              {
                inherit timeout environments;
                programs = map entry programs;
              }
              // lib.optionalAttrs (nodeTests != null) {
                nodeTests = {
                  dir = "${nodeTestSources}";
                  data = nodeTestData;
                };
              }
            )
          );
        in
        assert lib.assertMsg (
          lib.isInt timeout && timeout > 0
        ) "programs ${name}: timeout is whole seconds, a positive integer, not ${builtins.toJSON timeout}";

        assert lib.assertMsg
          (environments != [ ] && lib.all (environment: lib.elem environment allEnvironments) environments)
          "programs ${name}: environments must be some of ${toString allEnvironments}, not ${toString environments}";

        assert lib.assertMsg (
          programs != [ ] || nodeTests != null
        ) "programs ${name}: no programs and no nodeTests, so nothing to run";

        assert lib.assertMsg (nodeTests == null || lib.elem "node" environments)
          "programs ${name}: nodeTests run in the node environment, which isn't among ${toString environments}";

        vitestCheck {
          name = "test-programs-${name}";
          inherit packageDir expectedResults vitestArgs;
          env.IBUS_WEB_TEST_PROGRAMS = manifest;
          inBrowsers = environments != [ "node" ];

          # Vitest holds each program to its own limit; this one, past every
          # program's in every environment, and as long again for each test
          # file, catches a browser or Vitest that hangs outright.
          limit = (
            (timeout + 60)
            * (builtins.length environments * builtins.length programs + builtins.length nodeTestFiles)
            + 300
          );
        };
    in
    {
      ibusWeb.testing = {
        browserLinkFlags = "-sASSERTIONS=1 -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=worker -sEXIT_RUNTIME=1";

        # A program on its own needs nothing of a main module's.
        nodeLinkFlags = lib.concatStringsSep " " (
          lib.filter (flag: !lib.hasPrefix "-sMAIN_MODULE" flag) toolchain.testMainFlagList
        );

        inherit program programs;
      };
    };
}
