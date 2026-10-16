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
      inherit (config.ibusWeb) runtime typescript;
    in
    {
      ibusWeb.engines.mkEngineManifest =
        {
          name,
          package,
          threads,
          heapBytes,
          settingsSchemaDir,
          engines,
          settingsSchemas,
          settingsPaths ? { },
          settingsPatterns ? { },
        }:
        let
          closure = pkgs.closureInfo { rootPaths = [ package ]; };
          settingsMetadata = config.ibusWeb.engines.mkSettingsMetadata {
            inherit
              settingsSchemaDir
              settingsSchemas
              settingsPaths
              settingsPatterns
              ;
          };
          license = config.ibusWeb.lib.spdxExpression package.meta.license;

          # Descriptors can come from another derivation's build; the check below
          # validates them with the rest of the manifest, so evaluation never reads them.
          enginesFile =
            if builtins.isList engines then
              pkgs.writeText "ibus-web-${name}-engines.json" (builtins.toJSON engines)
            else
              engines;

          # The schema list, too, can come from another derivation's build.
          schemasFile =
            if builtins.isList settingsSchemas then
              pkgs.writeText "ibus-web-${name}-settings-schemas.json" (builtins.toJSON settingsSchemas)
            else
              settingsSchemas;

          description = pkgs.writeText "ibus-web-${name}-manifest-fields.json" (
            builtins.toJSON {
              inherit name threads settingsSchemaDir;
              inherit (package) version;
            }
          );
        in
        pkgs.runCommand "ibus-web-${name}-dist"
          {
            nativeBuildInputs = [
              typescript.nodejs
              pkgs.jq
              pkgs.gnutar
              pkgs.brotli
            ];
            # Runtime changes must invalidate the distribution even when its
            # numeric ABI and the engine module happen to remain unchanged.
            runtimeBuild = runtime.ibusRuntime;
            passthru = { inherit heapBytes; };
          }
          ''
            mkdir -p $out/data
            cp ${package}/${name}.wasm $out/${name}.wasm
            cp ${settingsMetadata} $out/settings.json
            node ${../../tools/engine-manifest/symlinks.ts} ${closure}/store-paths ${package}
            : > data.jsonl
            while IFS= read -r storePath; do
              if [ "$storePath" = ${lib.escapeShellArg (toString package)} ]; then continue; fi
              file="$(basename "$storePath").tar.br"
              # Entries are named from the store, so a store path that is a
              # single file archives like a directory, and the installer can
              # check that each lies under the archive's own store path. Hard
              # links, which store optimisation makes of identical files, are
              # stored as files: the installer takes none.
              tar ${config.ibusWeb.lib.archiveTarFlags} \
                --hard-dereference -C /nix/store -cf data.tar "$(basename "$storePath")"
              # The bytes the installer writes: every name of a hard-linked
              # file in full, and nothing for a link.
              size=$(find "$storePath" -type f -printf '%s\n' | awk '{ sum += $1 } END { print sum + 0 }')
              brotli --quality=11 --output="$out/data/$file" data.tar
              jq -nc --arg storePath "$storePath" --arg url "./data/$file" --argjson size "$size" \
                '{ $storePath, $url, $size, encoding: "br" }' >> data.jsonl
            done < ${closure}/store-paths
            mib=1048576
            # The module's static data is allocated in the heap as it loads,
            # so heapBytes holds it. Integer arithmetic rounds the 25% headroom
            # up to whole MiB.
            memory=$(( ((${toString runtime.memory.minimum} + ${toString threads} * mib + ${toString heapBytes}) * 5 + 4 * mib - 1) / (4 * mib) * mib ))
            test "$memory" -le ${toString runtime.memory.maximum}
            abi=$(jq '.abi' ${runtime.exportList}/exports.json)
            runtimeIdentity=$(jq -r '.identity' ${runtime.exportList}/exports.json)
            protocol=$(node ${../../tools/engine-manifest/protocol.ts} version ${
              typescript.workspaceFor [ "packages/protocol" ]
            }/packages/protocol/dist/index.js)
            # The output identity covers the recipe and every build input,
            # including data, schema, protocol and runtime dependencies.
            identity="''${out##*/}"
            identity="''${identity%%-*}"
            jq --arg identity "$identity" --argjson runtimeAbi "$abi" --arg runtimeIdentity "$runtimeIdentity" \
              --argjson protocol "$protocol" --argjson memory "$memory" \
              --arg url './${name}.wasm' --argjson size "$(stat -c%s $out/${name}.wasm)" \
              --rawfile license ${license} \
              --argjson settingsMetadata "$(jq -nc --arg url ./settings.json --argjson size "$(stat -c%s $out/settings.json)" '{ $url, $size }')" \
              --slurpfile data data.jsonl --slurpfile engines ${enginesFile} --slurpfile settingsSchemas ${schemasFile} \
              '.version += "+nix." + $identity | . + { $license, $runtimeAbi, $runtimeIdentity, $protocol, $memory, module: { $url, $size }, $data, engines: $engines[0], settingsSchemas: $settingsSchemas[0], $settingsMetadata }' \
              ${description} > $out/manifest.json
            node ${../../tools/engine-manifest/protocol.ts} check ${
              typescript.workspaceFor [ "packages/protocol" ]
            }/packages/protocol/dist/index.js \
              $out/manifest.json ${toString runtime.memory.minimum} ${toString runtime.memory.maximum}
          '';
    };
}
