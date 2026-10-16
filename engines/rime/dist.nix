# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-3.0-or-later
{
  perSystem =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      inherit (config.ibusWeb) engines;
      inherit (config.ibusWeb.toolchain) pkgsWasm;

      luaPackage = lib.findFirst (
        input: (input.pname or "") == "lua"
      ) (throw "librime-lua propagates no Lua") pkgsWasm.librime-lua.propagatedBuildInputs;

      # ibus-rime's, and those of everything the module links (librime, its Lua
      # and octagram plugins and their dependencies) and of its data
      # (rime-data's schema packages, rime-loengfan and rime-ice).
      licenses = lib.concatMap (component: lib.toList component.meta.license) [
        pkgsWasm.ibus-engines.rime
        pkgsWasm.librime
        pkgsWasm.librime-lua
        pkgsWasm.librime-octagram
        pkgsWasm.leveldb
        pkgsWasm.yaml-cpp
        pkgsWasm.opencc
        pkgsWasm.glog
        luaPackage
        pkgsWasm.marisa
        pkgsWasm.boost
        pkgs.rime-data
        pkgsWasm.rime-loengfan
        pkgs.rime-ice
      ];

      # Lua keeps its copyright notice at the end of lua.h, not in a file of
      # its own.
      luaNotice = pkgs.runCommand "ibus-web-rime-lua-notice" { } ''
        tar -xOzf ${luaPackage.src} --wildcards '*/src/lua.h' \
          | sed -n '/^\* Copyright (C) 1994/,/^\*\*\*\*\*\*/p' \
          | sed 's/^\* \{0,1\}//; /^\*\*\*\*/d' > $out
        grep -q 'Lua.org, PUC-Rio' $out
      '';

      # CC-BY-4.0 asks for credit to the works' creator, a link to the licence
      # and word of any change; the deployer compiles both into binary tables.
      attribution = pkgs.writeText "ibus-web-rime-attribution.md" ''
        # Attribution

        These works are under the Creative Commons Attribution 4.0 International licence
        (https://creativecommons.org/licenses/by/4.0/, the text in CC-BY-4.0.txt). Rime's
        deployer compiles each into binary tables at build time; nothing else is changed.

        - jyut6ping3, the Cantonese dictionary, by CanCLID, from rime-cantonese
          (https://github.com/rime/rime-cantonese), as rime-data ${pkgs.rime-data.version} carries it.
        - loengfan, by CanCLID, from rime-loengfan (https://github.com/CanCLID/rime-loengfan)
          at commit ${pkgsWasm.rime-loengfan.src.rev}.
      '';

      # The copyright notices the permissive licences ask to travel with the
      # module, each from its component's source, and the attribution.
      # OpenCC's and Boost's licence files are the generic texts.
      notices = {
        "LICENSES/librime/LICENSE" = "${pkgsWasm.librime.src}/LICENSE";
        "LICENSES/librime-lua/LICENSE" = "${pkgsWasm.librime-lua.src}/LICENSE";
        "LICENSES/leveldb/LICENSE" = "${pkgsWasm.leveldb.src}/LICENSE";
        "LICENSES/yaml-cpp/LICENSE" = "${pkgsWasm.yaml-cpp.src}/LICENSE";
        "LICENSES/glog/COPYING" = "${pkgsWasm.glog.src}/COPYING";
        "LICENSES/lua/COPYRIGHT" = luaNotice;
        "LICENSES/marisa/COPYING.md" = "${pkgs.srcOnly pkgsWasm.marisa}/COPYING.md";
        "LICENSES/rime-loengfan/LICENSE" = "${pkgsWasm.rime-loengfan.src}/LICENSE";
        "LICENSES/ATTRIBUTION.md" = attribution;
      };

      # rime-loengfan's LICENSE is CC-BY-4.0's full text, upstream's own copy.
      licenseTexts."CC-BY-4.0" = "${pkgsWasm.rime-loengfan.src}/LICENSE";

      dist = lib.makeOverridable (
        {
          schemas ? null,
        }:
        let
          rime =
            if schemas == null then
              config.packages.ibus-web-rime
            else
              config.packages.ibus-web-rime.override { inherit schemas; };

          # The schema list reaches the module, its deployment, descriptors,
          # dictionary paths and settings paths, so everything here follows it.
          package = rime.overrideAttrs (old: {
            meta = old.meta // {
              license = licenses;
            };
          });
          inherit (package) descriptors;

          # Each engine's dictionaries are data of its own, installed when it is
          # first made.
          enginesWithData =
            pkgs.runCommand "ibus-web-rime-engines.json" { nativeBuildInputs = [ pkgs.jq ]; }
              ''
                jq --slurpfile data ${descriptors}/engine-data.json 'map(. + { data: $data[0][.name] })' \
                  ${descriptors}/engines.json > $out
              '';

          manifest = engines.mkEngineManifest {
            name = "rime";
            inherit package;
            inherit (package) settingsSchemaDir;
            engines = enginesWithData;
            settingsSchemas = "${descriptors}/settings-schemas.json";
            settingsPaths = "${descriptors}/settings-paths.json";
            settingsPatterns."org.freedesktop.ibus.engine.rime.schema" =
              "/org/freedesktop/ibus/engine/rime/{schema}/";

            # Rime maps its tables, which WasmFS serves as copies in memory, and
            # dlmalloc never lowers the break. A settings change's redeployment
            # loads each schema's table to check it, rime_ice's 60.7 MB copy
            # once for every schema that uses it, and the next key opens a
            # session that loads it again. Where those copies land among the
            # blocks that outlive them differs from run to run: in the runs
            # traced, rime-host's page-size change ended its redeployment at 84
            # to 125 MB of break and its session added nothing or 8.4 MB, while
            # the highest break measured, 152,223,744 bytes, a heap of
            # 149,747,776, had the session's table above it all. Without the
            # change the heap peaks at 99,764,288 bytes, with rime_ice and
            # luna_pinyin open in one Worker. The workload runs one engine
            # thread at a time, the deployer's; LevelDB's compaction thread
            # stays once started, so a deployment after it needs a second. The
            # declaration leaves several MiB above the highest peak, and the
            # manifest builder adds headroom after it.
            threads = 2;
            heapBytes = 147 * 1024 * 1024;
          };
        in
        manifest.overrideAttrs (old: {
          passthru = old.passthru // {
            inherit licenses licenseTexts notices;
          };
        })
      ) { };
    in
    {
      packages.ibus-web-rime-dist = dist;

      ibusWeb.demo.modules.rime = dist;
    };
}
