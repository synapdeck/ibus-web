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

      # pnpm-workspace.yaml's `packages:` block list. Nix has no YAML reader, so
      # this reads that one key line by line, and inside it any line it doesn't
      # recognise throws: a form it can't read must not be skipped silently.
      workspaceGlobs =
        let
          file = "pnpm-workspace.yaml";
          # A quoted or plain scalar; the first matching group of the three
          # inner ones is its value.
          scalar = plain: ''("([^"]*)"|'([^']*)'|(${plain}))'';
          valueOf = groups: lib.findFirst (group: group != null) null groups;
          comment = "([[:space:]]+#.*)?[[:space:]]*";
          matchItem = builtins.match "[[:space:]]*-[[:space:]]+${scalar "[^\"'#[:space:]][^#[:space:]]*"}${comment}";
          matchKey = builtins.match "([^[:space:]#][^:]*):(.*)";
          isBlank = line: builtins.match "[[:space:]]*(#.*)?" line != null;
          isIndented = line: builtins.match "[[:space:]].*" line != null;

          step =
            state: line:
            let
              item = matchItem line;
              key = matchKey line;
              keyName = builtins.elemAt key 0;
            in
            if isBlank line then
              state
            else if state.inPackages && item != null then
              let
                glob = valueOf (lib.sublist 1 3 item);
              in
              if lib.hasPrefix "!" glob then
                throw "${file}: negated package globs are not supported: ${glob}"
              else
                state // { globs = state.globs ++ [ glob ]; }
            else if !isIndented line && key != null then
              if keyName != "packages" then
                state // { inPackages = false; }
              else if isBlank (builtins.elemAt key 1) then
                state // { inPackages = true; }
              else
                throw "${file}: `packages:` must be in block style, not ${line}"
            else if state.inPackages then
              throw "${file}: can't read this line under `packages:`: ${line}"
            else
              state;

          globs =
            (lib.foldl' step {
              inPackages = false;
              globs = [ ];
            } (lib.splitString "\n" (builtins.readFile (root + "/${file}")))).globs;
        in
        if globs == [ ] then throw "${file}: no `packages:` list found" else globs;

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
            throw "pnpm-workspace.yaml: ${glob} has no package.json"
        else if !lib.hasSuffix "/*" glob || lib.hasInfix "*" parent then
          throw "pnpm-workspace.yaml: only `<dir>` and `<dir>/*` package globs are supported, not ${glob}"
        else if !builtins.pathExists (root + "/${parent}") then
          [ ]
        else
          map (name: "${parent}/${name}") (lib.attrNames (lib.filterAttrs isPackage entries))
      ) workspaceGlobs;

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
              "pnpm-workspace.yaml"
              "pnpm-lock.yaml"
            ]
          );

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
      manifests = lib.fileset.toSource {
        inherit root;
        fileset = lib.fileset.unions (
          workspaceFiles ++ map (dir: root + "/${dir}/package.json") packageDirs
        );
      };
      pnpmDeps = pkgs.fetchPnpmDeps {
        pname = "ibus-web";
        src = manifests;
        inherit pnpm;
        fetcherVersion = 4;
        hash = "sha256-5g9FGePWwjfsBCfTugEZToxZEjWRTbEHXGSQw4vRThE=";
      };

      mkWorkspace =
        name: attrs:
        pkgs.stdenvNoCC.mkDerivation (
          {
            inherit name pnpmDeps;
            src = lib.fileset.toSource {
              inherit root;
              # Every package's tsconfig extends the repository's base.
              fileset = lib.fileset.unions (
                workspaceFiles ++ [ (root + "/tsconfig.base.json") ] ++ map packageSources packageDirs
              );
            };
            nativeBuildInputs = [
              nodejs
              pnpm
              pkgs.pnpmConfigHook
            ];
            preBuild = assertPlaywrightVersion;
          }
          // attrs
        );

      workspace = mkWorkspace "ibus-web-typescript" {
        buildPhase = ''
          runHook preBuild
          pnpm -r run build
          runHook postBuild
        '';
        installPhase = ''
          runHook preInstall
          mkdir -p $out
          cp -R package.json pnpm-workspace.yaml node_modules $out/
          ${lib.concatMapStrings (dir: ''
            mkdir -p $out/${dirOf dir}
            cp -R ${dir} $out/${dir}
          '') packageDirs}
          runHook postInstall
        '';
      };

      # Each package's node_modules, and the root's, without the sources.
      nodeModules = pkgs.stdenvNoCC.mkDerivation {
        name = "ibus-web-node-modules";
        inherit pnpmDeps;
        src = manifests;
        nativeBuildInputs = [
          nodejs
          pnpm
          pkgs.pnpmConfigHook
        ];
        dontBuild = true;
        installPhase = ''
          runHook preInstall
          mkdir -p $out
          cp -R node_modules $out/
          ${lib.concatMapStrings (dir: ''
            mkdir -p $out/${dir}
            cp -R ${dir}/node_modules $out/${dir}/
          '') packageDirs}
          runHook postInstall
        '';
      };

      # The lockfile resolves typescript to one version, whichever packages
      # depend on it.
      tsc = pkgs.runCommand "ibus-web-tsc" { nativeBuildInputs = [ pkgs.makeWrapper ]; } ''
        packages=(${workspace}/node_modules/.pnpm/typescript@*/node_modules/typescript)
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
        assertDependency = ./assert-dependency.ts;
      };

      devshells.default.packages = [
        nodejs
        pnpm
        tsc
      ];
    };
}
