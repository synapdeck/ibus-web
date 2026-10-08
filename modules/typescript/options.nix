# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.typescript = {
      pnpmWorkspace = lib.mkOption {
        type = lib.types.attrsOf lib.types.anything;
        description = "pnpm-workspace.yaml's content: the workspace's package globs (each `<dir>` or `<dir>/*`), the dependencies allowed to run builds, and the catalog.";
      };

      pnpmWorkspaceFile = lib.mkOption {
        type = lib.types.package;
        description = "pnpm-workspace.yaml as generated from pnpmWorkspace, which builds of the workspace use in place of the tracked copy, so they follow the Nix before `write-files` has run.";
      };

      nodejs = lib.mkOption {
        type = lib.types.package;
        description = "The Node that runs the workspace's JavaScript, in checks and in the dev shell.";
      };
      tsc = lib.mkOption {
        type = lib.types.package;
        description = "The workspace's TypeScript compiler, as bin/tsc, for type checks outside the workspace's packages.";
      };

      presets = lib.mkOption {
        type = lib.types.package;
        description = ''
          @ibus-web/tsconfig's presets, for a build that type-checks or compiles
          sources outside the pnpm workspace: it copies this to
          node_modules/@ibus-web/tsconfig at the root of its tree, where every
          config's `extends` finds it.
        '';
      };

      assertDependency = lib.mkOption {
        type = lib.types.path;
        description = "A Node script, run as `node <it> [--locked] <package> <version> <why> <package directory>...`, that fails unless each directory resolves the package at exactly that version; for dependencies whose version something outside the lockfile fixes. --locked says the manifests name a range, which the lockfile holds at that version.";
      };
      nodeModules = lib.mkOption {
        type = lib.types.package;
        description = ''
          The workspace's dependencies alone, installed offline from its manifests: the
          root's node_modules and each package's, at their paths in the repository. For
          a script that runs from the repository with its package's dependencies, in a
          build that shouldn't follow every change to the workspace's sources.
        '';
      };
      packageNodeModules = lib.mkOption {
        type = lib.types.functionTo lib.types.str;
        description = "Given a workspace package's directory, as a path, its node_modules in nodeModules.";
      };
      workspaceFor = lib.mkOption {
        type = lib.types.functionTo lib.types.package;
        description = ''
          Given repository-relative workspace package directories, build their sources
          and transitive workspace dependencies (including development dependencies).
          Uses the shared offline dependency install and repository configuration;
          source edits outside that closure do not invalidate the build.
        '';
      };
      workspace = lib.mkOption {
        type = lib.types.package;
        description = ''
          The pnpm workspace, installed offline and compiled with tsc: each package at
          its path in the repository, with its sources, its dist/ (the JavaScript
          browsers load) and the node_modules Node needs to run it.
        '';
      };

      npmTarball = lib.mkOption {
        type = lib.types.functionTo lib.types.package;
        description = ''
          Packs an npm package with `pnpm pack`, its lifecycle scripts included,
          into a derivation holding the tarball alone. Takes:

          - `name`, the derivation's name;
          - `src`, the tree to pack from, and `dir`, the package's directory in
            it (default `.`), so a package whose scripts read the rest of the
            workspace can be packed from a built workspace;
          - `files`, Nix-built files or directories to copy into the package
            first, by their path in it;
          - `licenses`, SPDX identifiers whose texts the repository's LICENSES/
            gives to the package's LICENSES/;
          - `expect`, paths in the package the tarball must contain;
          - `postPack`, shell run in the package directory once it is packed.
        '';
      };

      extraSources = lib.mkOption {
        type = lib.types.attrsOf (lib.types.listOf lib.types.str);
        default = { };
        description = ''
          Repository files and directories outside a workspace package that its build or
          tests read, by the package's directory, as repository-relative paths.
          workspaceFor copies them in whenever it selects that package, at the same paths.
        '';
      };
    };
  };
}
