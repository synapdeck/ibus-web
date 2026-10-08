# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.testing.playwright = {
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

      env = lib.mkOption {
        type = lib.types.attrsOf lib.types.str;
        description = "Environment variables under which the workspace's playwright package launches nixpkgs' headless browsers offline, as a derivation's attributes or exported in a shell, and IBUS_WEB_CHROMIUM_SANDBOX (1 or 0) for the harnesses.";
      };

      setup = lib.mkOption {
        type = lib.types.lines;
        description = "Shell commands a Nix build runs before launching the browsers. For builds only: it points HOME at a fresh directory.";
      };
    };
  };

  config.perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb.testing) playwright;

      # Headless Chromium uses its shell; the full browser and video encoder stay out.
      browsers = pkgs.playwright-driver.browsers.override {
        withChromium = false;
        withWebkit = true;
        withFfmpeg = false;
      };
    in
    {
      ibusWeb.testing.playwright = {
        env = {
          PLAYWRIGHT_BROWSERS_PATH = "${browsers}";
          PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
          # Playwright checks the host's distribution packages for the
          # browsers' libraries; Nix links them in instead.
          PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "1";
          IBUS_WEB_CHROMIUM_SANDBOX = if playwright.chromiumSandbox then "1" else "0";
        }
        // lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          PLAYWRIGHT_HOST_PLATFORM_OVERRIDE = "ubuntu-24.04";
          # WebKit needs an EGL platform even headless; the sandbox has no host GPU driver.
          LIBGL_ALWAYS_SOFTWARE = "1";
          __EGL_VENDOR_LIBRARY_FILENAMES = "${pkgs.mesa}/share/glvnd/egl_vendor.d/50_mesa.json";
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
