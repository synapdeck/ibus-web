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
            passthru = { inherit heapBytes; };
          }
          ''
            mkdir -p $out/data
            cp ${package}/${name}.wasm $out/${name}.wasm
            : > data.jsonl
            while IFS= read -r storePath; do
              if [ "$storePath" = ${lib.escapeShellArg (toString package)} ]; then continue; fi
              file="$(basename "$storePath").tar.br"
              tar --format=ustar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
                --mode=u+rw,go=rX -C "$storePath" -cf data.tar .
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
            protocol=$(node --input-type=module -e 'import { PROTOCOL_VERSION } from "${typescript.workspace}/packages/protocol/dist/index.js"; console.log(PROTOCOL_VERSION)')
            jq --argjson runtimeAbi "$abi" --argjson protocol "$protocol" --argjson memory "$memory" \
              --arg url './${name}.wasm' --argjson size "$(stat -c%s $out/${name}.wasm)" \
              --slurpfile data data.jsonl \
              '. + { $runtimeAbi, $protocol, $memory, module: { $url, $size }, $data }' \
              ${description} > $out/manifest.json
            node --input-type=module - "$out/manifest.json" <<'JS'
            import { readFileSync } from "node:fs";
            import { decodeEngineManifest } from "${typescript.workspace}/packages/protocol/dist/index.js";
            decodeEngineManifest(JSON.parse(readFileSync(process.argv[2], "utf8")), {
              minimum: ${toString runtime.memory.minimum}, maximum: ${toString runtime.memory.maximum}
            });
            JS
          '';
      checks.engine-manifest =
        (testing.vitestCheck {
          name = "engine-manifest";
          packageDir = "${typescript.workspace}/tools";
          env.IBUS_WEB_DYLINK_FIXTURE = fixture.wasm;
          inBrowsers = false;
          limit = 60;
          vitestArgs = [ "engine-manifest/dylink.test.ts" ];
        }).overrideAttrs
          (old: {
            nativeBuildInputs = (old.nativeBuildInputs or [ ]) ++ [ pkgs.wabt ];
          });
    };
}
