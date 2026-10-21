# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.testing.browserChecks = lib.mkOption {
      type = lib.types.lazyAttrsOf lib.types.package;
      default = { };
      description = "Checks that launch browsers, which become the flake's checks where playwright.inChecks.";
    };

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

      inChecks = lib.mkOption {
        type = lib.types.bool;
        description = ''
          Whether the flake's checks launch browsers. They don't on Darwin, where they are
          untried without the browsers' own sandboxes; CI's macOS Playwright job and the
          Safari smoke suite cover the browsers there.
        '';
      };

      env = lib.mkOption {
        type = lib.types.attrsOf lib.types.str;
        description = "Environment variables under which the workspace's playwright package launches nixpkgs' headless browsers offline, as a derivation's attributes or exported in a shell, and IBUS_WEB_CHROMIUM_SANDBOX (1 or 0) for the harnesses.";
      };

      setup = lib.mkOption {
        type = lib.types.lines;
        description = "Shell commands a Nix build runs before launching the browsers. For builds only: it points HOME at a fresh directory and, on macOS, turns off the browsers' own sandboxes.";
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
      checks = lib.mkIf playwright.inChecks config.ibusWeb.testing.browserChecks;

      ibusWeb.testing.playwright = {
        inChecks = !pkgs.stdenv.hostPlatform.isDarwin;

        env = {
          PLAYWRIGHT_BROWSERS_PATH = "${browsers}";
          PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
          # Playwright checks the host's distribution packages for the
          # browsers' libraries; Nix links them in instead.
          PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "1";
          IBUS_WEB_CHROMIUM_SANDBOX = if playwright.chromiumSandbox then "1" else "0";
        }
        // lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          # Playwright takes the browsers' directory names from the
          # platform's architecture suffix.
          PLAYWRIGHT_HOST_PLATFORM_OVERRIDE =
            if pkgs.stdenv.hostPlatform.isAarch64 then "ubuntu24.04-arm64" else "ubuntu24.04-x64";
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
        ''
        # A process a Nix build starts on macOS can't start a sandbox of its
        # own ("sandbox initialization failed"), so there the browsers run
        # without theirs.
        + lib.optionalString pkgs.stdenv.hostPlatform.isDarwin ''
          export IBUS_WEB_CHROMIUM_SANDBOX=0
          export MOZ_DISABLE_CONTENT_SANDBOX=1 MOZ_DISABLE_GMP_SANDBOX=1 MOZ_DISABLE_RDD_SANDBOX=1
          export MOZ_DISABLE_SOCKET_PROCESS_SANDBOX=1 MOZ_DISABLE_UTILITY_SANDBOX=1 MOZ_DISABLE_GPU_SANDBOX=1
        ''
        # Firefox finds its folders from the user's home directory through
        # CoreFoundation, which ignores HOME; a build user's is /var/empty.
        # CoreFoundation takes CFFIXED_USER_HOME instead.
        + lib.optionalString pkgs.stdenv.hostPlatform.isDarwin ''
          export CFFIXED_USER_HOME=$HOME
        '';
      };

      # So Vitest's browser runs from a checkout launch the checks' browsers.
      devshells.default.env = lib.mapAttrsToList (name: value: { inherit name value; }) playwright.env;
    };
}
