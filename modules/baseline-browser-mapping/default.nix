# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.baselineBrowserMapping = lib.mkOption {
      type = lib.types.package;
      description = "baseline-browser-mapping, whose CLI maps a Baseline target to the browser versions that meet it.";
    };
  };

  config.perSystem =
    { pkgs, ... }:
    let
      package = pkgs.buildNpmPackage (finalAttrs: {
        pname = "baseline-browser-mapping";
        version = "2.11.27";
        __structuredAttrs = true;
        strictDeps = true;

        src = pkgs.fetchFromGitHub {
          owner = "web-platform-dx";
          repo = "baseline-browser-mapping";
          tag = "v${finalAttrs.version}";
          hash = "sha256-8NWa/WcIeyVJX4OFWlj8XM8J5XNLorJCA1MskDxcB2I=";
        };

        npmDepsHash = "sha256-H4qq92B4acs9epQOviIvoD6g3/897UWmz0OKPt0k1/A=";

        # There are no runtime dependencies; what's left is only the pruned lockfile
        # and the cache from the `prettier --write` step in upstream's build script.
        postInstall = ''
          rm -r $out/lib/node_modules/baseline-browser-mapping/node_modules
        '';

        passthru.updateScript = pkgs.nix-update-script { };

        meta = {
          description = "Baseline-browser-mapping exposes arrays of browsers compatible with Baseline Widely Available and specified Baseline year feature sets";
          homepage = "https://github.com/web-platform-dx/baseline-browser-mapping";
          changelog = "https://github.com/web-platform-dx/baseline-browser-mapping/releases/tag/${finalAttrs.src.tag}";
          license = lib.licenses.asl20;
          mainProgram = "baseline-browser-mapping";
          platforms = lib.platforms.all;
        };
      });
    in
    {
      ibusWeb.baselineBrowserMapping = package;
    };
}
