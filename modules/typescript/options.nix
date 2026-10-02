# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.typescript = {
      nodejs = lib.mkOption {
        type = lib.types.package;
        description = "The Node that runs the workspace's JavaScript, in checks and in the dev shell.";
      };
      tsc = lib.mkOption {
        type = lib.types.package;
        description = "The workspace's TypeScript compiler, as bin/tsc, for type checks outside the workspace's packages.";
      };
      assertDependency = lib.mkOption {
        type = lib.types.path;
        description = "A Node script, run as `node <it> [--locked] <package> <version> <why> <package directory>...`, that fails unless each directory resolves the package at exactly that version; for dependencies whose version something outside the lockfile fixes. --locked says the manifests name a range, which the lockfile holds at that version.";
      };
      workspace = lib.mkOption {
        type = lib.types.package;
        description = ''
          The pnpm workspace, installed offline and compiled with tsc: each package at
          its path in the repository, with its sources, its dist/ (the JavaScript
          browsers load) and the node_modules Node needs to run it.
        '';
      };
    };
  };
}
