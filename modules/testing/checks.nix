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
      inherit (config.ibusWeb) testing;
      inherit (config.ibusWeb.toolchain) pkgsWasm;
      fixtures = ./fixtures;
      pkgConfig = "${pkgsWasm.stdenv.cc.targetPrefix}pkg-config";

      browsers = [
        "chromium"
        "firefox"
      ];

      # One fixture program, built for Node or for browsers: name.js,
      # name.wasm and, if the fixture has one, name.args.
      fixture =
        {
          name,
          format,
          gtest ? false,
          glib ? false,
          browserLinkFlags ? "",
        }:
        node:
        let
          source = "${name}.${if gtest then "cpp" else "c"}";
          args = fixtures + "/${name}.args";
          hasArgs = builtins.pathExists args;
          glibFlags = what: lib.optionalString glib "$(${pkgConfig} --${what} glib-2.0)";
        in
        pkgsWasm.stdenv.mkDerivation {
          name = "ibus-web-test-programs-fixture-${name}-${if node then "node" else "browser"}";
          src = lib.fileset.toSource {
            root = fixtures;
            fileset = lib.fileset.unions (
              [
                (fixtures + "/${source}")
                (lib.fileset.fileFilter (file: file.hasExt "h") fixtures)
              ]
              ++ lib.optional hasArgs args
            );
          };
          nativeBuildInputs = lib.optional glib pkgsWasm.pkg-config;
          buildInputs = lib.optional glib pkgsWasm.glib;
          dontFixup = true;
          buildPhase = ''
            runHook preBuild
            ${
              if gtest then "$CXX ${testing.gtestMain.cflags}" else "$CC ${glibFlags "cflags"}"
            } -c ${source} -o ${name}.o
            $CXX ${if node then testing.nodeLinkFlags else "${testing.browserLinkFlags} ${browserLinkFlags}"} \
              ${name}.o ${lib.optionalString gtest testing.gtestMain.libs} ${glibFlags "libs"} -o ${name}.js
            runHook postBuild
          '';
          installPhase = ''
            runHook preInstall
            install -Dm644 -t $out ${name}.js ${name}.wasm ${lib.optionalString hasArgs "${name}.args"}
            runHook postInstall
          '';
          passthru.testProgram = { inherit name format; };
        };

      fixturePrograms = [
        {
          name = "googletest";
          format = "gtest-json";
          gtest = true;
        }
        {
          name = "glib-tap";
          format = "tap";
          glib = true;
        }
        {
          name = "persist.1";
          format = "gtest-json";
          gtest = true;
        }
        {
          name = "persist.2";
          format = "gtest-json";
          gtest = true;
        }
        # After the sequence above, which left a value stored.
        {
          name = "cleared";
          format = "gtest-json";
          gtest = true;
        }
        # In a browser, one pthread, started from the pool so main can join
        # it without yielding to the event loop.
        {
          name = "pthread-output";
          format = "tap";
          browserLinkFlags = "-sPTHREAD_POOL_SIZE=1";
        }
        {
          name = "no-report";
          format = "gtest-json";
        }
        {
          name = "stop.1";
          format = "gtest-json";
          gtest = true;
        }
        {
          name = "stop.2";
          format = "gtest-json";
          gtest = true;
        }
      ];

      # What each environment reports: the failing tests fail on purpose. A
      # case's time is the one its program measured, give or take what the
      # clock and the scheduler add. Each program's suite ends with its run.
      case = status: path: { inherit path status; };
      timed = status: path: durationMs: { inherit path status durationMs; };
      run =
        program: status:
        case status [
          program
          "run"
        ];
      expected = [
        (case "passed" [
          "googletest"
          "Fixture"
          "Passes"
        ])
        (case "failed" [
          "googletest"
          "Fixture"
          "FailsOnPurpose"
        ])
        (case "skipped" [
          "googletest"
          "Fixture"
          "SkipsOnPurpose"
        ])
        (timed "passed" [ "googletest" "Timing" "SleepsOnPurpose" ] [ 200 400 ])
        (run "googletest" "passed")
        (case "passed" [
          "glib-tap"
          "fixture"
          "passes"
        ])
        (case "failed" [
          "glib-tap"
          "fixture"
          "fails-on-purpose"
        ])
        (timed "passed" [ "glib-tap" "fixture" "slow" ] [ 600 800 ])
        (case "passed" [
          "glib-tap"
          "fixture"
          "arguments"
        ])
        (run "glib-tap" "passed")
        (case "passed" [
          "persist.1"
          "Persist"
          "Stores"
        ])
        (run "persist.1" "passed")
        (case "passed" [
          "persist.2"
          "Persist"
          "ReadsWhatTheFirstStored"
        ])
        (run "persist.2" "passed")
        (case "passed" [
          "cleared"
          "Cleared"
          "StartsWithNothingStored"
        ])
        (run "cleared" "passed")
        (case "passed" [
          "pthread-output"
          "pthread"
          "output"
        ])
        (run "pthread-output" "passed")
        # It lists nothing.
        (run "no-report" "failed")
        (case "failed" [
          "stop.1"
          "Stop"
          "FailsOnPurpose"
        ])
        (run "stop.1" "passed")
        (case "skipped" [
          "stop.2"
          "Stop"
          "NeverRuns"
        ])
        (run "stop.2" "failed")
      ];

      # One case selected by name, with its program's run: the program runs
      # that case alone, or its run fails for reporting the others.
      filter = "^[a-z]+ > googletest > (Fixture > Passes|run)$";
      selected = [
        [
          "googletest"
          "Fixture"
          "Passes"
        ]
        [
          "googletest"
          "run"
        ]
      ];
      expectedFiltered = map (
        test: if lib.elem test.path selected then test else case "skipped" test.path
      ) expected;

      check =
        {
          node,
          filtered ? false,
        }:
        let
          environments = if node then [ "node" ] else browsers;
        in
        testing.programs {
          name = "fixtures-${if node then "node" else "browsers"}${lib.optionalString filtered "-filtered"}";
          programs = map (spec: fixture spec node) fixturePrograms;
          inherit environments;
          expectedResults = lib.genAttrs environments (_: if filtered then expectedFiltered else expected);
          vitestArgs = lib.optionals filtered [
            "-t"
            filter
          ];
        };
    in
    {
      # The shim's own test: each fixture's cases come out where and as
      # they should in every environment, the failing ones failing, and a
      # case selected by name runs alone.
      checks.test-programs = pkgs.linkFarm "ibus-web-test-programs" {
        node = check { node = true; };
        browsers = check { node = false; };
        node-filtered = check {
          node = true;
          filtered = true;
        };
        browsers-filtered = check {
          node = false;
          filtered = true;
        };
      };
    };
}
