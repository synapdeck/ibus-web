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
      inherit (config.ibusWeb) runtime typescript testing;
      fixture = runtime.mkSideModule {
        name = "manifest-fixture";
        src = ../../tools/engine-manifest;
        sources = [ "fixture.c" ];
      };
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
        }:
        let
          closure = pkgs.closureInfo { rootPaths = [ package ]; };
          licenses = lib.toList package.meta.license;
          description = pkgs.writeText "${name}-manifest-fields.json" (
            builtins.toJSON {
              inherit
                name
                threads
                settingsSchemaDir
                engines
                settingsSchemas
                ;
              inherit (package) version;
              license = lib.concatMapStringsSep " AND " (license: license.spdxId) licenses;
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
              tar --format=ustar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
                --hard-dereference -C /nix/store -cf data.tar "$(basename "$storePath")"
              # The bytes the installer writes: every name of a hard-linked
              # file in full, and nothing for a link.
              size=$(find "$storePath" -type f -printf '%s\n' | awk '{ sum += $1 } END { print sum + 0 }')
              brotli --quality=11 --output="$out/data/$file" data.tar
              jq -nc --arg storePath "$storePath" --arg url "./data/$file" --argjson size "$size" \
                '{ $storePath, $url, $size, encoding: "br" }' >> data.jsonl
            done < ${closure}/store-paths
            static=$(node ${../../tools/engine-manifest/dylink.ts} $out/${name}.wasm)
            mib=1048576
            # Integer arithmetic rounds the 25% headroom up to whole MiB.
            memory=$(( ((${toString runtime.memory.minimum} + static + ${toString threads} * mib + ${toString heapBytes}) * 5 + 4 * mib - 1) / (4 * mib) * mib ))
            test "$memory" -le ${toString runtime.memory.maximum}
            abi=$(jq '.abi' ${runtime.exportList}/exports.json)
            protocol=$(node ${../../tools/engine-manifest/protocol.ts} version ${typescript.workspace}/packages/protocol/dist/index.js)
            # The output identity covers the recipe and every build input,
            # including data, schema, protocol and runtime dependencies.
            identity="''${out##*/}"
            identity="''${identity%%-*}"
            jq --arg identity "$identity" --argjson runtimeAbi "$abi" --argjson protocol "$protocol" --argjson memory "$memory" \
              --arg url './${name}.wasm' --argjson size "$(stat -c%s $out/${name}.wasm)" \
              --slurpfile data data.jsonl \
              '.version += "+nix." + $identity | . + { $runtimeAbi, $protocol, $memory, module: { $url, $size }, $data }' \
              ${description} > $out/manifest.json
            node ${../../tools/engine-manifest/protocol.ts} check ${typescript.workspace}/packages/protocol/dist/index.js \
              $out/manifest.json ${toString runtime.memory.minimum} ${toString runtime.memory.maximum}
          '';
      checks.engine-manifest =
        (testing.vitestCheck {
          name = "engine-manifest";
          packageDir = "${typescript.workspace}/tools";
          env.IBUS_WEB_DYLINK_FIXTURE = fixture.wasm;
          inBrowsers = false;
          limit = 60;
          vitestArgs = [
            "engine-manifest/dylink.test.ts"
            "engine-manifest/symlinks.test.ts"
            "engine-manifest/protocol.test.ts"
          ];
        }).overrideAttrs
          (old: {
            nativeBuildInputs = (old.nativeBuildInputs or [ ]) ++ [ pkgs.wabt ];
          });
    };
}
