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
      inherit (config.ibusWeb.typescript) nodejs;
      inherit (pkgs) pnpm;
      root = ../..;

      # pnpm-workspace.yaml's content, which `files` writes into the tree and
      # checks there: the workspace's package globs, and its catalog.
      pnpmWorkspace = {
        packages = [
          "runtime/wasmfs-idb"
          "modules/glib/checks/tests"
          "tools"
          "packages/*"
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
          "@types/node" = "^24.19.0";
          effect = "^4.0.0";
          # Exactly the driver whose browsers nixpkgs provides.
          playwright = pkgs.playwright-driver.version;
          typescript = "^7.0.2";
          vitest = "^5.0.3";
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
        pkgs.runCommand "pnpm-workspace.yaml"
          {
            yaml = (pkgs.formats.yaml { }).generate "pnpm-workspace.yaml" pnpmWorkspace;
          }
          ''
            {
              echo "# Generated from modules/typescript/default.nix by \`nix run .#write-files\`."
              cat "$yaml"
            } > $out
          '';

      # Repository-relative directories of the workspace's packages.
      packageDirs = lib.concatMap (
        glob:
        let
          parent = lib.removeSuffix "/*" glob;
          entries = builtins.readDir (root + "/${parent}");
          isPackage =
            name: type: type == "directory" && builtins.pathExists (root + "/${parent}/${name}/package.json");
        in
        if !lib.hasInfix "*" glob then
          if builtins.pathExists (root + "/${glob}/package.json") then
            [ glob ]
          else
            throw "pnpm workspace: ${glob} has no package.json"
        else if !lib.hasSuffix "/*" glob || lib.hasInfix "*" parent then
          throw "pnpm workspace: only `<dir>` and `<dir>/*` package globs are supported, not ${glob}"
        else if !builtins.pathExists (root + "/${parent}") then
          [ ]
        else
          map (name: "${parent}/${name}") (lib.attrNames (lib.filterAttrs isPackage entries))
      ) pnpmWorkspace.packages;

      # What tsc reads from a package, selected by extension anywhere in its
      # directory (.ts, .mts, .cts, .json), plus the files it lists in
      # package.json under `ibusWeb.assets` (paths relative to the package,
      # such as an HTML page). Anything else, such as C sources, stays out, so
      # editing it rebuilds nothing here.
      packageSources =
        dir:
        let
          assets = (lib.importJSON (root + "/${dir}/package.json")).ibusWeb.assets or [ ];
          assetPath =
            asset:
            if lib.hasPrefix "/" asset || lib.elem ".." (lib.splitString "/" asset) then
              throw "${dir}/package.json: ibusWeb.assets must stay inside the package, not ${asset}"
            else
              root + "/${dir}/${asset}";
        in
        lib.fileset.unions (
          [
            (lib.fileset.fileFilter (
              file:
              lib.any file.hasExt [
                "ts"
                "mts"
                "cts"
                "json"
              ]
            ) (root + "/${dir}"))
          ]
          ++ map assetPath assets
        );

      rootManifest = lib.importJSON (root + "/package.json");

      # pnpm compares itself with `packageManager` and, offline, can't fetch a
      # different version, so it has to name the pnpm nixpkgs provides.
      workspaceFiles =
        lib.throwIfNot (rootManifest.packageManager or null == "pnpm@${pnpm.version}")
          "package.json: packageManager is ${
            builtins.toJSON (rootManifest.packageManager or null)
          }, but nixpkgs' pnpm is ${pnpm.version}"
          (
            map (file: root + "/${file}") [
              "package.json"
              "pnpm-lock.yaml"
            ]
          );

      # The sources with pnpm-workspace.yaml as Nix generates it, so the build
      # follows the Nix even before `write-files` has updated the tree. Named
      # as a fileset's source is: pnpm records the directory it installed in,
      # and the build that runs scripts over nodeModules must unpack to the
      # same one, or pnpm takes the install for stale and tries to fetch.
      withWorkspaceFile =
        src:
        pkgs.runCommand "source" { } ''
          cp -R ${src} $out
          chmod u+w $out
          cp ${pnpmWorkspaceFile} $out/pnpm-workspace.yaml
        '';

      # Each Playwright release expects specific browser builds, and the
      # browsers come from nixpkgs' playwright-driver, so the installed npm
      # package has to be that exact version. Node resolves it from each
      # package that depends on it, and Vitest's Playwright provider, whose
      # peer it is, from each package that depends on the provider.
      playwrightDependents = lib.filter (
        dir:
        let
          manifest = lib.importJSON (root + "/${dir}/package.json");
        in
        lib.any
          (
            field:
            lib.any (dependency: manifest.${field} or { } ? ${dependency}) [
              "playwright"
              "@vitest/browser-playwright"
            ]
          )
          [
            "dependencies"
            "devDependencies"
            "optionalDependencies"
            "peerDependencies"
          ]
      ) ([ "." ] ++ packageDirs);
      assertPlaywrightVersion = ''
        node ${./assert-dependency.ts} playwright ${
          lib.escapeShellArgs (
            [
              pkgs.playwright-driver.version
              "its browsers come from nixpkgs' playwright-driver"
            ]
            ++ playwrightDependents
          )
        }
      '';

      # Installing needs only the manifests, so editing a source leaves the
      # dependency fetch's inputs alone.
      manifests = withWorkspaceFile (
        lib.fileset.toSource {
          inherit root;
          fileset = lib.fileset.unions (
            workspaceFiles ++ map (dir: root + "/${dir}/package.json") packageDirs
          );
        }
      );
      pnpmDeps = pkgs.fetchPnpmDeps {
        pname = "ibus-web";
        src = manifests;
        inherit pnpm;
        fetcherVersion = 4;
        hash = "sha256-7CfoySnqrReRjFHxEu9pFs3Z0D9wL3IRacKzTzTNJsE=";
      };

      # Each package's node_modules, and the root's, installed offline
      # without the sources.
      nodeModules = pkgs.stdenvNoCC.mkDerivation {
        name = "ibus-web-node-modules";
        inherit pnpmDeps;
        src = manifests;
        nativeBuildInputs = [
          nodejs
          pnpm
          pkgs.pnpmConfigHook
        ];
        buildPhase = ''
          runHook preBuild
          ${assertPlaywrightVersion}
          runHook postBuild
        '';
        # A package with no dependencies has no node_modules.
        installPhase = ''
          runHook preInstall
          mkdir -p $out
          cp -R node_modules $out/
          for dir in ${lib.escapeShellArgs packageDirs}; do
            if [ -d "$dir/node_modules" ]; then
              mkdir -p "$out/$dir"
              cp -R "$dir/node_modules" "$out/$dir/"
            fi
          done
          runHook postInstall
        '';
      };

      # The sources with nodeModules laid over them, whose links between
      # packages and into the root's store are relative, then compiled.
      workspace = pkgs.stdenvNoCC.mkDerivation {
        name = "ibus-web-typescript";
        src = withWorkspaceFile (
          lib.fileset.toSource {
            inherit root;
            # Every package's tsconfig extends the repository's base.
            fileset = lib.fileset.unions (
              workspaceFiles
              ++ [
                (root + "/tsconfig.base.json")
                (root + "/tsconfig.node-scripts.json")
              ]
              ++ map packageSources packageDirs
            );
          }
        );
        nativeBuildInputs = [
          nodejs
          pnpm
        ];
        configurePhase = ''
          runHook preConfigure
          # Modes kept, for the executables; the store's are read-only.
          cp -R ${nodeModules}/. .
          chmod -R u+w .
          runHook postConfigure
        '';
        buildPhase = ''
          runHook preBuild
          pnpm -r run build
          runHook postBuild
        '';
        installPhase = ''
          runHook preInstall
          mkdir -p $out
          # Tests that run from source are compiled through their configs,
          # which extend the repository's base.
          cp -R package.json pnpm-workspace.yaml tsconfig.base.json tsconfig.node-scripts.json node_modules $out/
          ${lib.concatMapStrings (dir: ''
            mkdir -p $out/${dirOf dir}
            cp -R ${dir} $out/${dir}
          '') packageDirs}
          runHook postInstall
        '';
      };

      # The lockfile resolves typescript to one version, whichever packages
      # depend on it.
      tsc = pkgs.runCommand "ibus-web-tsc" { nativeBuildInputs = [ pkgs.makeWrapper ]; } ''
        packages=(${nodeModules}/node_modules/.pnpm/typescript@*/node_modules/typescript)
        if [ ''${#packages[@]} -ne 1 ] || [ ! -d "''${packages[0]}" ]; then
          echo "expected one typescript in the workspace, found: ''${packages[*]}" >&2
          exit 1
        fi
        makeWrapper ${lib.getExe nodejs} $out/bin/tsc --add-flags "''${packages[0]}/bin/tsc"
      '';
    in
    {
      ibusWeb.typescript = {
        nodejs = pkgs.nodejs_24;
        inherit workspace nodeModules tsc;
        packageNodeModules =
          dir:
          let
            relative = lib.path.removePrefix root dir;
          in
          lib.throwIfNot (lib.elem (lib.removePrefix "./" relative) packageDirs)
            "packageNodeModules: ${relative} isn't a package of the workspace"
            "${nodeModules}/${relative}/node_modules";
        assertDependency = ./assert-dependency.ts;
      };

      files.file."pnpm-workspace.yaml".source = pnpmWorkspaceFile;

      devshells.default.packages = [
        nodejs
        pnpm
        tsc
      ];
    };
}
