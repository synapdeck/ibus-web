# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{ inputs, lib, ... }:
{
  perSystem =
    {
      config,
      pkgs,
      system,
      ...
    }:
    let
      inherit (config.ibusWeb)
        demo
        release
        runtime
        toolchain
        typescript
        ;
      inherit (config.ibusWeb.lib) archiveTarFlags;

      self = toString inputs.self;
      commit = inputs.self.rev or inputs.self.dirtyRev or "unknown";

      # Changesets keeps every published package in one fixed group, so a
      # release has one version.
      version =
        let
          versions = lib.unique (
            map (dir: (lib.importJSON (../.. + "/${dir}/package.json")).version) typescript.publishedPackages
          );
        in
        if lib.length versions == 1 then
          lib.head versions
        else
          throw "the published packages' versions differ: ${toString versions}";

      # What a module links: its build inputs, theirs, and so on. The tools a
      # build runs are no part of what it links.
      linked =
        roots:
        let
          entry = drv: {
            key = drv.drvPath;
            inherit drv;
          };
        in
        map ({ drv, ... }: drv) (
          builtins.genericClosure {
            startSet = map entry roots;
            operator =
              { drv, ... }:
              map entry (
                lib.filter lib.isDerivation ((drv.buildInputs or [ ]) ++ (drv.propagatedBuildInputs or [ ]))
              );
          }
        );

      # A package's own sources, without the repository's, which the bundle
      # holds whole.
      sourcesOf =
        drv:
        lib.filter (source: !(lib.hasPrefix self (toString source))) (
          lib.toList (drv.src or [ ]) ++ (drv.srcs or [ ])
        );

      flakeInputs = lib.removeAttrs inputs [ "self" ];

      # Everything an engine and the runtime it loads into are built from
      # (design spec §9.3): the repository with its recipes, overrides,
      # patches and flake.lock; every flake input, nixpkgs' recipes among
      # them; and the upstream source of each library linked, of Emscripten,
      # whose libraries every module links, and of the engine's data.
      sourceBundle =
        name:
        { module, extraSources, ... }:
        let
          packaged = lib.filter (drv: sourcesOf drv != [ ]) (linked [
            module
            runtime.ibusRuntime
          ]);
          entries =
            map (drv: {
              inherit (drv) name;
              sources = sourcesOf drv;
            }) packaged
            ++ map (drv: {
              inherit (drv) name;
              sources = if drv ? outputHash then [ drv ] else sourcesOf drv;
            }) extraSources
            ++ [
              {
                inherit (toolchain.emscripten) name;
                sources = [ toolchain.emscripten.src ];
              }
            ];

          readme = pkgs.writeText "ibus-web-engine-${name}-src-README.md" ''
            # The source of ibus-web's ${name} engine, ${version}

            Everything `@ibus-web/engine-${name}` ${version} and the runtime it
            loads into were built from, at commit ${commit}:

            - `repository/`: ibus-web, with every recipe, override and patch,
              and `flake.lock`, which pins the rest.
            - `flake-inputs/`: each flake `flake.lock` names, nixpkgs among
              them, as Nix fetched it.
            - `sources/`: under each package's name, the upstream source of
              the engine, of every library it and the runtime link, of
              Emscripten, whose libraries every module links, and of the
              engine's data.

            To build the engine from these alone:

            ```sh
            nix build ./repository#packages.${system}.ibus-web-${name}-dist \
            ${
              lib.concatMapStrings (input: "  --override-input ${input} path:./flake-inputs/${input} \\\n") (
                lib.attrNames flakeInputs
              )
            }  -L
            ```

            Nix fetches each upstream source by its hash; the copies under
            `sources/` are those files.
          '';
        in
        pkgs.runCommand "ibus-web-engine-${name}-src-${version}"
          {
            nativeBuildInputs = [
              pkgs.gnutar
              pkgs.xz
            ];
          }
          ''
            mkdir -p tree/sources tree/flake-inputs
            cp ${readme} tree/README.md
            cp -r --no-preserve=mode ${inputs.self} tree/repository
            ${lib.concatStrings (
              lib.mapAttrsToList (input: source: ''
                cp -r --no-preserve=mode ${source} tree/flake-inputs/${input}
              '') flakeInputs
            )}
            ${lib.concatMapStrings (
              { name, sources }:
              lib.concatMapStrings (source: ''
                mkdir -p tree/sources/${name}
                cp -r --no-preserve=mode ${source} tree/sources/${name}/${lib.escapeShellArg (baseNameOf (toString source))}
              '') sources
            ) entries}

            mkdir $out
            tar ${archiveTarFlags} -C tree -cf - . | xz -T0 -6 > $out/engine-${name}-src-${version}.tar.xz
          '';

      bundles = lib.mapAttrs sourceBundle release.engines;

      notes =
        pkgs.runCommand "ibus-web-release-notes-${version}" { nativeBuildInputs = [ typescript.nodejs ]; }
          ''
            node ${typescript.workspaceFor [ "tools/release" ]}/tools/release/cli.ts ${version} ${
              lib.concatMapStringsSep " " (dir: "${../.. + "/${dir}"}") typescript.publishedPackages
            } > $out
          '';

      # What a tag publishes: assets/ for the GitHub release, flat, and
      # notes.md for its text (design spec §10.7). An engine's .wasm, data
      # archives and manifest travel as one tar of its distribution.
      releaseAssets =
        pkgs.runCommand "ibus-web-release-${version}"
          {
            nativeBuildInputs = [
              pkgs.gnutar
              pkgs.jq
            ];
            passthru = { inherit bundles version; };
          }
          ''
            mkdir -p $out/assets
            cd $out/assets

            cp ${config.legacyPackages.npm.all}/*.tgz .
            cp ${runtime.ibusRuntime}/ibus-runtime.js ${runtime.ibusRuntime}/ibus-runtime.wasm .
            cp ${config.files.file."packages/protocol/PROTOCOL.md".source} PROTOCOL.md
            ${lib.concatStrings (
              lib.mapAttrsToList (name: engine: ''
                tar ${archiveTarFlags} --dereference -C ${engine.dist} -cf engine-${name}-${version}.tar .
                cp ${bundles.${name}}/*.tar.xz .
              '') release.engines
            )}

            # Each asset's size and digest, with what produced it. The list is
            # taken first: the pipeline creates release.json while it runs.
            assets=(*)
            for asset in "''${assets[@]}"; do
              jq -n --arg name "$asset" --argjson size "$(stat -c%s "$asset")" \
                --arg sha256 "$(sha256sum "$asset" | cut -d' ' -f1)" '{ $name, $size, $sha256 }'
            done | jq -s --arg version ${version} --arg commit ${commit} \
              --argjson runtimeAbi "$(jq .abi ${runtime.ibusRuntime}/exports.json)" \
              '{ $version, $commit, $runtimeAbi, assets: . }' > release.json

            cp ${notes} $out/notes.md
          '';

      missing = lib.attrNames (lib.removeAttrs demo.modules (lib.attrNames release.engines));
    in
    {
      packages =
        lib.mapAttrs' (name: bundle: lib.nameValuePair "engine-${name}-src" bundle) bundles
        # The release's outputs are WebAssembly and JavaScript, the same
        # whatever builds them, so one system builds it.
        // lib.optionalAttrs (system == "x86_64-linux") { release = releaseAssets; };

      # Every engine the project builds ships with its source bundle (design
      # spec §9.4).
      checks.tools-release-source-bundles =
        if missing == [ ] then
          pkgs.runCommand "ibus-web-tools-release-source-bundles" { } "touch $out"
        else
          throw "engines without a source bundle in ibusWeb.release.engines: ${toString missing}";
    };
}
