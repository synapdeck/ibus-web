# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-3.0-or-later
{
  lib,
  runCommand,
  writeText,
  nodejs,
  ibus-engines,
  ibus-web-rime-tools,
  ibus-web-rime-descriptor-program,
  rime-data,
  rime-ice,
  rime-loengfan,
  opencc-data,
  # The schemas to deploy and register as engines; their dependencies
  # deploy whether listed or not.
  schemas ? null,
}:
let
  table = import ./_schemas.nix;

  # The mainstream schemas, in the order the engines are listed, rime_ice
  # first, then every other engine, by id.
  mainstream = [
    "rime_ice"
    "double_pinyin"
    "double_pinyin_flypy"
    "double_pinyin_mspy"
    "double_pinyin_sogou"
    "double_pinyin_ziguang"
    "double_pinyin_abc"
    "double_pinyin_jiajia"
    "luna_pinyin"
    "terra_pinyin"
    "bopomofo"
    "cangjie5"
    "quick5"
    "wubi86"
    "stroke"
    "jyut6ping3"
    "wugniu"
  ];
  everySchema =
    mainstream
    ++ lib.filter (id: !lib.elem id mainstream && table.${id}.engine or true) (lib.attrNames table);

  shipped =
    let
      listed = if schemas == null then everySchema else schemas;
      unknown = lib.filter (id: !table ? ${id}) listed;
    in
    assert lib.assertMsg (unknown == [ ]) "rime: no such schema: ${toString unknown}";
    assert lib.assertMsg (lib.unique listed == listed) "rime: a schema is listed twice";
    listed;

  # The shipped schemas and, transitively, the schemas they depend on,
  # which the deployment compiles too.
  deployed = map (entry: entry.key) (
    builtins.genericClosure {
      startSet = map (id: { key = id; }) shipped;
      operator =
        entry:
        map (id: { key = id; }) (table.${entry.key}.dependencies ++ table.${entry.key}.undeclared or [ ]);
    }
  );

  dictionaryNames = lib.unique (map (id: table.${id}.dictionary) deployed);

  # rime-data, then rime-loengfan, then rime-ice, whose double_pinyin*
  # replace rime-data's of the same names, with ibus-rime's own
  # configuration and a default.yaml listing every schema to deploy: Rime
  # compiles a schema's declared dependencies on its own, but not the rest.
  source = runCommand "ibus-web-rime-source" { } ''
    mkdir $out
    cp -r ${rime-data}/share/rime-data/. $out/
    chmod -R u+w $out
    cp -r ${rime-loengfan}/share/rime-data/. $out/
    chmod -R u+w $out
    cp -r ${rime-ice}/share/rime-data/. $out/
    chmod -R u+w $out
    rm -r $out/build $out/AGENTS.md
    cp ${ibus-engines.rime}/share/rime-data/ibus_rime.yaml $out/

    awk -v list=${lib.escapeShellArg (toString deployed)} '
      /^schema_list:/ {
        print
        n = split(list, ids, " ")
        for (i = 1; i <= n; i++) print "  - schema: " ids[i]
        skipping = 1
        next
      }
      skipping && /^  - / { next }
      { skipping = 0; print }
    ' ${rime-data}/share/rime-data/default.yaml > $out/default.yaml
  '';

  # rime_deployer, built for WebAssembly from the librime that reads its
  # output. Building rime_ice's table peaks near 900 MB.
  deployment = runCommand "ibus-web-rime-deployment" { nativeBuildInputs = [ nodejs ]; } ''
    node ${ibus-web-rime-tools}/rime_deployer.js --build "$TMPDIR/user" ${source} $out/build
    rm -f $out/build/user.yaml
  '';

  # What the descriptor program reads from the deployed configs.
  raw = runCommand "ibus-web-rime-raw-descriptors" { nativeBuildInputs = [ nodejs ]; } ''
    node ${ibus-web-rime-descriptor-program}/descriptors.js ${source} ${deployment}/build > $out
  '';

  # A dictionary's tables and the prisms of the schemas that read it.
  dictionaryFiles =
    name:
    [
      "${name}.table.bin"
      "${name}.reverse.bin"
    ]
    ++ map (id: "${id}.prism.bin") (lib.filter (id: table.${id}.dictionary == name) deployed);

  dicts = lib.genAttrs dictionaryNames (
    name:
    runCommand "ibus-web-rime-dict-${name}" { } ''
      mkdir -p $out/build
      for file in ${lib.escapeShellArgs (dictionaryFiles name)}; do
        if [ -e ${deployment}/build/$file ]; then
          cp ${deployment}/build/$file $out/build/
        fi
      done
    ''
  );

  # Rime's shared data directory: the deployment's configs, and links to the
  # dictionaries' compiled tables beside them, which Rime takes for its
  # prebuilt data; the configuration sources, symbols, Lua scripts and
  # OpenCC's data; and no dictionary source.
  common = runCommand "ibus-web-rime-common" { } ''
    mkdir $out
    cp -r ${source}/. $out/
    chmod -R u+w $out
    rm -r $out/*.dict.yaml $out/cn_dicts $out/en_dicts $out/essay*.txt
    cp -rn ${opencc-data}/share/opencc/. $out/opencc/

    mkdir $out/build
    cp ${deployment}/build/*.yaml $out/build/
    ${lib.concatMapStrings (name: ''
      for file in ${dicts.${name}}/build/*; do
        ln -s "$file" $out/build/
      done
    '') dictionaryNames}

    for file in ${deployment}/build/*.bin; do
      if [ ! -L $out/build/$(basename "$file") ]; then
        echo "no dictionary holds $(basename "$file")" >&2
        exit 1
      fi
    done
  '';

  plan = writeText "ibus-web-rime-plan.json" (
    builtins.toJSON {
      schemas = shipped;
      table = lib.genAttrs deployed (id: table.${id});
      dictionaries = lib.mapAttrs (_: path: "${path}") dicts;
    }
  );

  descriptors = runCommand "ibus-web-rime-descriptors" { nativeBuildInputs = [ nodejs ]; } ''
    node ${./descriptors/descriptors.ts} ${raw} ${plan} $out
    cp ${raw} $out/raw.json
  '';
in
{
  schemas = shipped;
  inherit
    source
    deployment
    dicts
    common
    descriptors
    ;
}
