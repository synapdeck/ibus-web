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

      # pnpm-workspace.yaml's `packages:` block list and `overrides:` block
      # mapping. Nix has no YAML reader, so this reads those two keys line by
      # line, and inside them any line it doesn't recognise throws: a form it
      # can't read must not be skipped silently.
      workspaceYaml =
        let
          file = "pnpm-workspace.yaml";
          # A quoted or plain scalar; the first matching group of the three
          # inner ones is its value.
          scalar = plain: ''("([^"]*)"|'([^']*)'|(${plain}))'';
          valueOf = groups: lib.findFirst (group: group != null) null groups;
          comment = "([[:space:]]+#.*)?[[:space:]]*";
          matchItem = builtins.match "[[:space:]]*-[[:space:]]+${scalar "[^\"'#[:space:]][^#[:space:]]*"}${comment}";
          matchEntry = builtins.match "[[:space:]]+${scalar "[^\"'#:[:space:]][^#:[:space:]]*"}:[[:space:]]+${scalar "[^\"'#[:space:]][^#[:space:]]*"}${comment}";
          matchKey = builtins.match "([^[:space:]#][^:]*):(.*)";
          isBlank = line: builtins.match "[[:space:]]*(#.*)?" line != null;
          isIndented = line: builtins.match "[[:space:]].*" line != null;

          step =
            state: line:
            let
              item = matchItem line;
              entry = matchEntry line;
              key = matchKey line;
              keyName = builtins.elemAt key 0;
              unreadable = throw "${file}: can't read this line under `${state.section}:`: ${line}";
            in
            if isBlank line then
              state
            else if state.section == "packages" && item != null then
              let
                glob = valueOf (lib.sublist 1 3 item);
              in
              if lib.hasPrefix "!" glob then
                throw "${file}: negated package globs are not supported: ${glob}"
              else
                state // { globs = state.globs ++ [ glob ]; }
            else if state.section == "overrides" && entry != null then
              state
              // {
                overrides = state.overrides // {
                  ${valueOf (lib.sublist 1 3 entry)} = valueOf (lib.sublist 5 3 entry);
                };
              }
            else if !isIndented line && key != null then
              if
                lib.elem keyName [
                  "packages"
                  "overrides"
                ]
              then
                if isBlank (builtins.elemAt key 1) then
                  state // { section = keyName; }
                else
                  throw "${file}: `${keyName}:` must be in block style, not ${line}"
              else
                state // { section = null; }
            else if state.section != null then
              unreadable
            else
              state;

          parsed = lib.foldl' step {
            section = null;
            globs = [ ];
            overrides = { };
          } (lib.splitString "\n" (builtins.readFile (root + "/${file}")));
        in
        if parsed.globs == [ ] then throw "${file}: no `packages:` list found" else parsed;

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
      ) workspaceYaml.globs;

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
              fileset = lib.fileset.unions (workspaceFiles ++ map packageSources packageDirs);
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
      nodeMajor = lib.versions.major nodejs.version;

      # Why `name` at `spec` disagrees with nixpkgs, or null. @types/node isn't
      # published for every Node patch release, so it needs only an exact
      # version with Node's major.
      versionProblem =
        name: spec:
        if pinnedVersions ? ${name} then
          if spec == pinnedVersions.${name} then
            null
          else
            "is ${spec}, but nixpkgs has ${pinnedVersions.${name}}"
        else if name == "@types/node" && !(isExactVersion spec && lib.versions.major spec == nodeMajor) then
          "is ${spec}, but needs an exact ${nodeMajor}.x.y for Node ${nodejs.version}"
        else
          null;

      # One line per entry of `specs` (name -> version spec) that disagrees.
      problemsIn =
        where: specs:
        lib.concatLists (
          lib.mapAttrsToList (
            name: spec:
            let
              problem = versionProblem name spec;
            in
            lib.optional (problem != null) "${where}: ${name} ${problem}"
          ) specs
        );

      # peerDependencies are held to the exact pins too, not a compatible range:
      # the workspace has one toolchain.
      dependencyFields = [
        "dependencies"
        "devDependencies"
        "optionalDependencies"
        "peerDependencies"
      ];

      # An override's key selects a package as
      # `[<parent>[@<range>]>]<name>[@<range>]`. A range can contain `>` too
      # (`>=5`, `^1||>2`, `>=1 >2`), but there it follows `@`, `|` or a space,
      # so only a `>` after any other character separates the parent.
      overrideTarget =
        selector:
        builtins.elemAt (builtins.match "(.*[^@|[:space:]]>)?(@?[^@>=[:space:]][^@>]*)(@.*)?" selector) 1;

      rootManifest = lib.importJSON (root + "/package.json");
      versionMismatches =
        lib.optional (rootManifest.packageManager or null != "pnpm@${pnpm.version}")
          "package.json: packageManager is ${
            builtins.toJSON (rootManifest.packageManager or null)
          }, but nixpkgs' pnpm_11 is ${pnpm.version}"
        ++ lib.concatMap (
          file:
          let
            manifest = lib.importJSON (root + "/${file}");
          in
          lib.concatMap (field: problemsIn "${file}: ${field}" (manifest.${field} or { })) dependencyFields
        ) ([ "package.json" ] ++ map (dir: "${dir}/package.json") packageDirs)
        ++ lib.concatLists (
          lib.mapAttrsToList (
            selector: spec:
            problemsIn "pnpm-workspace.yaml: overrides.\"${selector}\"" { ${overrideTarget selector} = spec; }
          ) workspaceYaml.overrides
        );
    in
    {
      ibusWeb.typescript = {
        nodejs = pkgs.nodejs_24;

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
      };

      checks.typescript = mkWorkspace "ibus-web-typescript-check" {
        buildPhase = ''
          runHook preBuild
          pnpm -r run typecheck
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
