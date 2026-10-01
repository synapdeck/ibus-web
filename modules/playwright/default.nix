# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.testing.playwright = {
      browsers = lib.mkOption {
        type = lib.types.package;
        description = "The browsers the workspace's playwright package drives, headless: nixpkgs' playwright-driver builds of Chromium's headless shell and Firefox.";
      };
      env = lib.mkOption {
        type = lib.types.attrsOf lib.types.str;
        description = "Environment variables under which the workspace's playwright package launches those browsers offline, as a derivation's attributes or exported in a shell.";
      };
      setup = lib.mkOption {
        type = lib.types.lines;
        description = "Shell commands a Nix build runs before launching the browsers.";
      };
    };
  };

  config.perSystem =
    { pkgs, ... }:
    let
      # Headless Chromium runs as its headless shell, so the full browser,
      # WebKit and ffmpeg (for recording video) stay out of the closure.
      browsers = pkgs.playwright-driver.browsers.override {
        withChromium = false;
        withWebkit = false;
        withFfmpeg = false;
      };
    in
    {
      ibusWeb.testing.playwright = {
        inherit browsers;
        env = {
          PLAYWRIGHT_BROWSERS_PATH = "${browsers}";
          PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
          # Playwright checks the host's distribution packages for the
          # browsers' libraries; Nix links them in instead.
          PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "1";
        };
        # Firefox writes to its XDG configuration and data directories under
        # HOME as it starts, even with the fresh profile Playwright gives
        # it, and hangs before Playwright can connect if it can't; a build's
        # HOME doesn't exist.
        setup = ''
          export HOME=$(mktemp -d)
        '';
      };
    };
}
