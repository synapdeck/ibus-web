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

      # One fixture program, built for Node or for browsers, with the
      # arguments in name.args if the fixture has one.
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
          argsFile = fixtures + "/${name}.args";
          glibFlags = what: lib.optionalString glib "$(${pkgConfig} --${what} glib-2.0)";
        in
        testing.program {
          inherit name format gtest;
          derivationName = "ibus-web-test-programs-fixture-${name}-${if node then "node" else "browser"}";
          src = fixtures;
          sources = [ "${name}.${if gtest then "cpp" else "c"}" ];
          cflags = glibFlags "cflags";
          linkFlags =
            if node then testing.nodeLinkFlags else "${testing.browserLinkFlags} ${browserLinkFlags}";
          libs = glibFlags "libs";
          args =
            if builtins.pathExists argsFile then
              lib.splitString "\n" (lib.removeSuffix "\n" (builtins.readFile argsFile))
            else
              null;
          nativeBuildInputs = lib.optional glib pkgsWasm.pkg-config;
          buildInputs = lib.optional glib pkgsWasm.glib;
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
      # case's time is the one its program measured: never less than the
      # case sleeps, and more by what the clock and a loaded machine's
      # scheduler add, which the bound leaves generous room for; the check
      # prints the time it found. Each program's suite ends with its run.
      case = status: path: { inherit path status; };
      timed = status: path: sleepMs: {
        inherit path status;
        durationMs = [
          sleepMs
          (sleepMs + 2000)
        ];
      };
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
        (timed "passed" [ "googletest" "Timing" "SleepsOnPurpose" ] 200)
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
        (timed "passed" [ "glib-tap" "fixture" "slow" ] 600)
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
      # that case alone, or its run fails for reporting the others. And the
      # second program of a sequence alone, which passes only if the first
      # still runs before it.
      filter = "^[a-z]+ > (googletest > (Fixture > Passes|run)|persist\\.2 > .*)$";
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
        [
          "persist.2"
          "Persist"
          "ReadsWhatTheFirstStored"
        ]
        [
          "persist.2"
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
