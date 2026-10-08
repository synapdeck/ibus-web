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
      inherit (config.ibusWeb.typescript) nodejs pnpmWorkspace pnpmWorkspaceFile;
      inherit (pkgs) pnpm;

      root = ../..;

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

      presets = lib.fileset.toSource {
        root = root + "/packages/tsconfig";
        fileset = root + "/packages/tsconfig";
      };

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
        node ${config.ibusWeb.typescript.assertDependency} playwright ${
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

      packageManifests = lib.genAttrs packageDirs (dir: lib.importJSON (root + "/${dir}/package.json"));
      dirsByName = lib.listToAttrs (
        map (dir: lib.nameValuePair packageManifests.${dir}.name dir) packageDirs
      );

      workspaceFor =
        requested:
        let
          selected = builtins.genericClosure {
            startSet = map (dir: {
              key =
                lib.throwIfNot (lib.elem dir packageDirs) "workspaceFor: ${dir} isn't a package of the workspace"
                  dir;
            }) requested;
            operator =
              { key }:
              let
                manifest = packageManifests.${key};

                localNames = lib.unique (
                  lib.concatMap
                    (
                      field:
                      lib.attrNames (
                        lib.filterAttrs (_: version: lib.hasPrefix "workspace:" version) (manifest.${field} or { })
                      )
                    )
                    [
                      "dependencies"
                      "devDependencies"
                      "optionalDependencies"
                      "peerDependencies"
                    ]
                );
              in
              map (name: {
                key =
                  dirsByName.${name} or (throw "workspaceFor: ${key} depends on unknown workspace package ${name}");
              }) localNames;
          };
        in
        buildWorkspace (lib.sort builtins.lessThan (map (entry: entry.key) selected));

      # The sources with nodeModules laid over them, whose links between
      # packages and into the root's store are relative, then compiled.
      buildWorkspace =
        selectedDirs:
        let
          # Files and directories outside the selected packages that their builds or tests read.
          extraInputs = lib.unique (
            lib.concatMap (dir: config.ibusWeb.typescript.extraSources.${dir} or [ ]) selectedDirs
          );
        in
        pkgs.stdenvNoCC.mkDerivation {
          name = "ibus-web-typescript";
          src = withWorkspaceFile (
            lib.fileset.toSource {
              inherit root;
              fileset = lib.fileset.unions (
                workspaceFiles
                # pnpm validates every workspace dependency in the root manifest and lockfile.
                ++ map (dir: root + "/${dir}/package.json") packageDirs
                ++ map (file: root + "/${file}") extraInputs
                ++ map packageSources selectedDirs
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
            pnpm -r${
              lib.optionalString (selectedDirs != packageDirs) (
                " "
                + lib.escapeShellArgs (
                  lib.concatMap (dir: [
                    "--filter"
                    packageManifests.${dir}.name
                  ]) selectedDirs
                )
              )
            } run --if-present build
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            mkdir -p $out
            # Keep manifest-only directories too: the shared install links to
            # every workspace package. Only selected packages contain sources
            # and compiled output.
            cp -R package.json pnpm-workspace.yaml node_modules $out/
            ${lib.concatMapStrings (dir: ''
              mkdir -p $out/${dirOf dir}
              cp -R ${dir} $out/${dir}
            '') packageDirs}
            ${lib.concatMapStrings (file: ''
              mkdir -p $out/${dirOf file}
              cp -R ${file} $out/${dirOf file}/
            '') extraInputs}
            runHook postInstall
          '';
        };

      workspace = buildWorkspace packageDirs;
    in
    {
      ibusWeb.typescript = {
        nodejs = pkgs.nodejs_24;
        inherit
          workspace
          workspaceFor
          nodeModules
          presets
          ;

        packageNodeModules =
          dir:
          let
            relative = lib.path.removePrefix root dir;
          in
          lib.throwIfNot (lib.elem (lib.removePrefix "./" relative) packageDirs)
            "packageNodeModules: ${relative} isn't a package of the workspace"
            "${nodeModules}/${relative}/node_modules";

        assertDependency = ../../tools/assert-dependency/assert-dependency.ts;
      };

      devshells.default.packages = [
        nodejs
        pnpm
      ];
    };
}
