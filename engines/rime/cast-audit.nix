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
      inherit (config.ibusWeb) engines toolchain;
      inherit (toolchain) pkgsWasm;
      ibus-rime = pkgsWasm.ibus-engines.rime;

      # The sources compile_commands.json lists for a target, in one
      # language.
      sourcesScript = ''
        const [commands, target, lang] = process.argv.slice(1);
        const suffix = lang === "C" ? /\.c$/ : /\.(cc|cpp)$/;
        for (const { file, output } of require(require("node:path").resolve(commands)))
          if (output.startsWith(target) && suffix.test(file)) console.log(file);
      '';

      # A CMake library's sources, audited with the flags its own configure
      # run gives the target that builds them: CMake writes each target's
      # flags to its flags.make and its sources to compile_commands.json.
      # lang is CXX or C, and only that language's sources are audited.
      cmakeAudit =
        {
          name,
          package,
          target,
          lang ? "CXX",
          extraCflags ? [ ],
        }:
        let
          sources = "node -e ${lib.escapeShellArg sourcesScript} build/compile_commands.json ${target}/ ${lang}";
        in
        (engines.castAudit {
          name = "rime-${name}";
          inherit (package) src;
          cflags = "$(< $TMPDIR/cflags)";
          sourcesFrom = sources;
          allowList = ./cast-audit + "/${name}.jsonc";
        }).overrideAttrs
          (old: {
            inherit (package) patches;
            cmakeFlags = package.cmakeFlags ++ [ "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON" ];
            postPatch = package.postPatch or "";
            preConfigure = package.preConfigure or "";
            nativeBuildInputs = old.nativeBuildInputs ++ package.nativeBuildInputs;
            buildInputs = (package.buildInputs or [ ]) ++ (package.propagatedBuildInputs or [ ]);
            dontConfigure = false;

            # The flags as make holds them, quoted for a shell; each a word.
            preBuild = ''
              make -s -f ${target}/flags.make -f - print-cflags > flags \
                <<< 'print-cflags: ; $(info $(${lang}_DEFINES) $(${lang}_INCLUDES) $(${lang}_FLAGS))@:'
              # emcc warns of the link settings the compiler wrapper passes
              # when it only compiles, which -Werror would make an error.
              eval "printf '%s\n' $(< flags)" | grep -vx -e -Werror > $TMPDIR/cflags
              printf '%s\n' ${lib.escapeShellArgs extraCflags} >> $TMPDIR/cflags
              cd ..
              echo "auditing $(${sources} | wc -l) sources"
            '';
          });

      luaPlugin = "plugins/librime-lua-static-${pkgsWasm.librime-lua.version}";
      octagramPlugin = "plugins/librime-octagram-static-${pkgsWasm.librime-octagram.version}";

      audits = {
        librime = cmakeAudit {
          name = "librime";
          package = pkgsWasm.librime;
          target = "src/CMakeFiles/rime-static.dir";
          # setup.cc alone takes the merged plugins' modules.
          extraCflags = [ "-DRIME_EXTRA_MODULES=,Q(lua),Q(octagram)" ];
        };
        librime-lua = cmakeAudit {
          name = "librime-lua";
          package = pkgsWasm.librime;
          target = "${luaPlugin}/CMakeFiles/rime-lua-objs.dir";
        };
        librime-lua-c = cmakeAudit {
          name = "librime-lua-c";
          package = pkgsWasm.librime;
          target = "${luaPlugin}/CMakeFiles/rime-lua-objs.dir";
          lang = "C";
        };
        librime-octagram = cmakeAudit {
          name = "librime-octagram";
          package = pkgsWasm.librime;
          target = "${octagramPlugin}/CMakeFiles/rime-octagram-objs.dir";
        };
        leveldb = cmakeAudit {
          name = "leveldb";
          package = pkgsWasm.leveldb;
          target = "CMakeFiles/leveldb.dir";
        };
        yaml-cpp = cmakeAudit {
          name = "yaml-cpp";
          package = pkgsWasm.yaml-cpp;
          target = "CMakeFiles/yaml-cpp.dir";
        };
        opencc = cmakeAudit {
          name = "opencc";
          package = pkgsWasm.opencc;
          target = "src/CMakeFiles/libopencc.dir";
        };
        glog = cmakeAudit {
          name = "glog";
          package = pkgsWasm.glog;
          target = "CMakeFiles/glog_internal.dir";
        };
        marisa = cmakeAudit {
          name = "marisa";
          package = pkgsWasm.marisa;
          target = "CMakeFiles/marisa.dir";
        };

        # The library's sources, with the flags its posix target gives them;
        # lua.c and luac.c are the programs.
        lua = engines.castAudit {
          name = "rime-lua";
          inherit (pkgsWasm.lua) src;
          cflags = "-O2 -fPIC -DLUA_USE_POSIX";
          sourcesFrom = "ls src/*.c | grep -v -e '^src/lua\\.c$' -e '^src/luac\\.c$'";
          allowList = ./cast-audit/lua.jsonc;
        };

        ibus-rime =
          (engines.castAudit {
            name = "rime-ibus-rime";
            inherit (ibus-rime) src;
            buildInputs = [
              pkgsWasm.libibus-web
              pkgsWasm.librime
            ];
            cflags = "$(< $TMPDIR/cflags)";
            sources = [
              "rime_engine.c"
              "rime_settings.c"
            ];
            allowList = ./cast-audit/ibus-rime.jsonc;
          }).overrideAttrs
            (old: {
              inherit (ibus-rime) patches;
              preBuild = ''
                eval "printf '%s\n' $(< ${ibus-rime}/lib/ibus-rime/cflags)" > $TMPDIR/cflags
                echo "-I${ibus-rime}/include/ibus-rime" >> $TMPDIR/cflags
              '';
            });
      };
    in
    {
      checks.rime-cast-audit = pkgs.linkFarm "ibus-web-rime-cast-audit" audits;
    };
}
