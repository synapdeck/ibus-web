# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{
  perSystem =
    { pkgs, ... }:
    let
      # pnpm-workspace.yaml's content, which `files` writes into the tree and
      # checks there: the workspace's package globs, and its catalog.
      pnpmWorkspace = {
        packages = [
          "packages/*"
          "tools/*"
          "examples/*"
          "runtime/ibus-runtime"
          "runtime/wasmfs-idb"
          "modules/emscripten"
          "modules/testing"
        ];

        # These packages ship N-API binaries for every supported build platform.
        allowBuilds = {
          tree-sitter = false;
          tree-sitter-c = false;
          tree-sitter-cpp = false;
        };

        # What must be one version across the repository, and the tools
        # packages share. Packages name these as `catalog:`, never with a
        # version of their own.
        catalog = {
          "@effect/vitest" = "^4.0.0";
          "@types/node" = "^26.6.4";
          effect = "^4.0.0";
          # Exactly the driver whose browsers nixpkgs provides.
          playwright = pkgs.playwright-driver.version;
          typescript = "^7.0.2";
          vitest = "^5.0.3";
          vite = "^8.0.0";
          "@vitest/browser" = "^5.0.3";
          "@vitest/browser-playwright" = "^5.0.3";
          ajv = "^8.20.0";
          brotli-dec-wasm = "^2.3.2";
          jsonc-parser = "^3.3.1";
          smol-toml = "^1.9.0";
          tsdown = "^0.23.0";
        };
      };

      # The generator writes no comments, so the one saying where the file
      # comes from goes first.
      pnpmWorkspaceFile =
        pkgs.runCommand "ibus-web-pnpm-workspace.yaml"
          {
            yaml = (pkgs.formats.yaml { }).generate "ibus-web-pnpm-workspace.yaml" pnpmWorkspace;
          }
          ''
            {
              echo "# Generated from modules/typescript/files.nix by \`nix run .#write-files\`."
              cat "$yaml"
            } | ${pkgs.oxfmt}/bin/oxfmt -c ${../../.oxfmtrc.jsonc} --stdin-filepath pnpm-workspace.yaml > $out
          '';
    in
    {
      ibusWeb.typescript = { inherit pnpmWorkspace pnpmWorkspaceFile; };

      files.file."pnpm-workspace.yaml".source = pnpmWorkspaceFile;
    };
}
