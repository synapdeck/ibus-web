# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.testing = {
      extendedChecks = lib.mkOption {
        type = lib.types.attrsOf lib.types.package;
        default = { };
        description = "Extended integration checks aggregated by packages.integration-checks, outside the default flake check gate.";
      };

      vitestCheck = lib.mkOption {
        type = lib.types.functionTo lib.types.package;
        description = ''
          A function making a check that runs a workspace package's Vitest suites, from
          the built workspace, with the configuration the package's vitest.config.ts
          makes, taking:

          - name: the derivation's name, after "ibus-web-".
          - packageDir: the package's directory in the built workspace.
          - env: the build's attributes, such as the manifest the configuration reads.
          - inBrowsers: whether any suite runs in a browser, which then gets
            playwright's environment and setup.
          - limit: whole seconds before the run is killed, a bound on a browser or Vitest
            that hangs outright, past every test's own limit.
          - vitestArgs (default none): more arguments for Vitest.
          - expectedResults (default null): when given, a set as programs takes it, and
            the check passes if Vitest's report matches it rather than when every test
            passes.
          - passthru (default none): as for mkDerivation.

          Its output holds Vitest's console output as output.txt and its JSON report as
          results.json.
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
      inherit (config.ibusWeb) typescript;
      inherit (config.ibusWeb.testing) playwright;

      # A failing test fails the check, unless expectedResults says which tests
      # fail on purpose: Vitest exits non-zero then, so the verdict comes from
      # its JSON report instead.
      vitestCheck =
        {
          name,
          packageDir,
          env,
          inBrowsers,
          limit,
          vitestArgs ? [ ],
          expectedResults ? null,
          passthru ? { },
        }:
        pkgs.runCommand "ibus-web-${name}"
          (
            {
              nativeBuildInputs = [ typescript.nodejs ];
              # Nix gives a build a terminal, on which Vitest would redraw its
              # progress into the log, over and over.
              CI = "1";
              inherit passthru;
            }
            // env
            // lib.optionalAttrs inBrowsers playwright.env
          )
          ''
            ${if inBrowsers then playwright.setup else "export HOME=$(mktemp -d)"}
            export IBUS_WEB_TEST_CACHE_DIR=$TMPDIR/vite
            mkdir $out
            status=0

            (
              set -o pipefail
              cd ${packageDir}
              timeout --kill-after=10 ${toString limit} \
                node node_modules/vitest/vitest.mjs run --configLoader native \
                  --reporter=default --reporter=json --outputFile.json=$out/results.json \
                  ${lib.escapeShellArgs vitestArgs} 2>&1 | tee $out/output.txt
            ) || status=$?

            ${
              if expectedResults == null then
                ''exit "$status"''
              else
                ''
                  node ${../../tools/expect-results/expect-results.ts} $out/results.json ${pkgs.writeText "ibus-web-expected-results.json" (builtins.toJSON expectedResults)}
                ''
            }
          '';
    in
    {
      ibusWeb.testing = { inherit vitestCheck; };

      packages.integration-checks = pkgs.linkFarm "ibus-web-integration-checks" (
        lib.mapAttrsToList (name: path: { inherit name path; }) config.ibusWeb.testing.extendedChecks
      );
    };
}
