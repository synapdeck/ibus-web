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
      pnpm = pkgs.pnpm_11;
      root = ../..;

      # The package globs under pnpm-workspace.yaml's `packages:` key. Nix has
      # no YAML reader, so this takes the block-list form the file uses.
      workspaceGlobs =
        let
          step =
            state: line:
            let
              item = builtins.match ''[[:space:]]+-[[:space:]]+["']?([^"'[:space:]]+)["']?[[:space:]]*'' line;
            in
            if builtins.match "packages:[[:space:]]*" line != null then
              state // { inPackages = true; }
            else if builtins.match "[^[:space:]#].*" line != null then
              state // { inPackages = false; }
            else if state.inPackages && item != null then
              state // { globs = state.globs ++ item; }
            else
              state;
          parsed = lib.foldl' step {
            inPackages = false;
            globs = [ ];
          } (lib.splitString "\n" (builtins.readFile (root + "/pnpm-workspace.yaml")));
        in
        if parsed.globs == [ ] then
          throw "pnpm-workspace.yaml: no `packages:` list found"
        else
          parsed.globs;

      # Repository-relative directories of the workspace's packages.
      packageDirs = lib.concatMap (
        glob:
        let
          parent = lib.removeSuffix "/*" glob;
          entries = builtins.readDir (root + "/${parent}");
          isPackage =
            name: type: type == "directory" && builtins.pathExists (root + "/${parent}/${name}/package.json");
        in
        if !lib.hasSuffix "/*" glob || lib.hasInfix "*" parent then
          throw "pnpm-workspace.yaml: only `<dir>/*` package globs are supported, not ${glob}"
        else if !builtins.pathExists (root + "/${parent}") then
          [ ]
        else
          map (name: "${parent}/${name}") (lib.attrNames (lib.filterAttrs isPackage entries))
      ) workspaceGlobs;

      workspaceFiles = map (file: root + "/${file}") [
        "package.json"
        "pnpm-workspace.yaml"
        "pnpm-lock.yaml"
      ];

      # Installing needs only the manifests, so editing a source leaves the
      # dependency fetch's inputs alone.
      pnpmDeps = pkgs.fetchPnpmDeps {
        pname = "ibus-web";
        src = lib.fileset.toSource {
          inherit root;
          fileset = lib.fileset.unions (
            workspaceFiles ++ map (dir: root + "/${dir}/package.json") packageDirs
          );
        };
        inherit pnpm;
        fetcherVersion = 4;
        hash = "sha256-2DZ3fh8Z3eYdlaxSJkzNSgH54KZ9P4aYqs2/wilY8Us=";
      };

      mkWorkspace =
        name: attrs:
        pkgs.stdenvNoCC.mkDerivation (
          {
            inherit name pnpmDeps;
            src = lib.fileset.toSource {
              inherit root;
              fileset = lib.fileset.unions (workspaceFiles ++ map (dir: root + "/${dir}") packageDirs);
            };
            nativeBuildInputs = [
              nodejs
              pnpm
              pkgs.pnpmConfigHook
            ];
          }
          // attrs
        );

      # The versions nixpkgs decides, which the manifests pin rather than
      # resolve independently.
      pinnedVersions = {
        playwright = pkgs.playwright-driver.version;
        typescript = pkgs.typescript.version;
      };
      isExactVersion = version: builtins.match "[0-9]+\\.[0-9]+\\.[0-9]+" version != null;

      rootManifest = lib.importJSON (root + "/package.json");
      versionMismatches =
        lib.optional (rootManifest.packageManager or null != "pnpm@${pnpm.version}")
          "package.json: packageManager is ${
            builtins.toJSON (rootManifest.packageManager or null)
          }, but nixpkgs' pnpm_11 is ${pnpm.version}"
        ++ lib.concatMap (
          dir:
          let
            manifest = lib.importJSON (root + "/${dir}/package.json");
            dependencies = (manifest.dependencies or { }) // (manifest.devDependencies or { });
            nodeTypes = dependencies."@types/node" or null;
            nodeMajor = lib.versions.major nodejs.version;
          in
          lib.mapAttrsToList
            (
              name: version: "${dir}/package.json: ${name} is ${dependencies.${name}}, but nixpkgs has ${version}"
            )
            (
              lib.filterAttrs (
                name: version: dependencies ? ${name} && dependencies.${name} != version
              ) pinnedVersions
            )
          ++
            lib.optional
              (nodeTypes != null && !(isExactVersion nodeTypes && lib.versions.major nodeTypes == nodeMajor))
              "${dir}/package.json: @types/node is ${nodeTypes}, but needs an exact ${nodeMajor}.x.y for Node ${nodejs.version}"
        ) packageDirs;
    in
    {
      ibusWeb.typescript = {
        nodejs = pkgs.nodejs_24;

        workspace = mkWorkspace "ibus-web-typescript" {
          buildPhase = ''
            runHook preBuild
            pnpm -r exec tsc -p .
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
      };

      checks.typescript = mkWorkspace "ibus-web-typescript-check" {
        buildPhase = ''
          runHook preBuild
          pnpm -r exec tsc -p . --noEmit
          runHook postBuild
        '';
        installPhase = "touch $out";
      };

      checks.typescript-versions = pkgs.runCommand "ibus-web-typescript-versions" { } (
        if versionMismatches == [ ] then
          "touch $out"
        else
          ''
            printf '%s\n' ${lib.escapeShellArgs versionMismatches} >&2
            exit 1
          ''
      );

      devshells.default.packages = [
        nodejs
        pnpm
      ];
    };
}
