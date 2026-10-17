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
    {
      ibusWeb.typescript.npmTarball =
        {
          name,
          src,
          dir ? ".",
          files ? { },
          licenses ? [ ],
          license ? null,
          expect ? [ ],
          postPack ? "",
        }:
        pkgs.runCommand name
          {
            nativeBuildInputs = [
              config.ibusWeb.typescript.nodejs
              pkgs.pnpm
              pkgs.jq
            ];
          }
          ''
            export HOME=$TMPDIR
            export pnpm_config_pm_on_fail=ignore
            # The install was made in another directory, which pnpm would
            # take for stale and install again before prepack.
            export pnpm_config_verify_deps_before_run=false

            # Writable, so files can be copied in and prepack can write.
            cp -R ${src} work
            chmod -R u+w work
            cd work/${dir}

            ${lib.concatStrings (
              lib.mapAttrsToList (path: source: ''
                mkdir -p "$(dirname ${lib.escapeShellArg path})"
                cp -RL ${source} ${lib.escapeShellArg path}
                chmod -R u+w ${lib.escapeShellArg path}
              '') files
            )}

            ${lib.optionalString (licenses != [ ]) ''
              mkdir -p LICENSES
              for id in ${lib.escapeShellArgs licenses}; do
                cp ${../../LICENSES}/"$id".txt LICENSES/
              done
            ''}

            ${lib.optionalString (license != null) ''
              declared=$(jq -r .license package.json)
              expected=${if lib.isDerivation license then "$(< ${license})" else lib.escapeShellArg license}
              if [ "$declared" != "$expected" ]; then
                echo "package.json says $declared, but its contents are $expected" >&2
                exit 1
              fi
            ''}

            # What prepack writes, postpack must take away again.
            listing() { find . -path ./node_modules -prune -o -print | sort; }
            listing > $TMPDIR/before.txt

            mkdir $out
            pnpm pack --pack-destination $out

            listing > $TMPDIR/after.txt
            if ! diff $TMPDIR/before.txt $TMPDIR/after.txt >&2; then
              echo "packing left the package directory changed" >&2
              exit 1
            fi

            tar -tzf $out/*.tgz > $TMPDIR/contents.txt
            {
              printf '%s\n' ${lib.escapeShellArgs expect}
              jq -r '[.exports // {} | .. | strings | select(contains("*") | not)] | unique[] | ltrimstr("./")' package.json
            } | while IFS= read -r entry; do
              [ -n "$entry" ] || continue
              grep -qxF "package/$entry" $TMPDIR/contents.txt || { echo "tarball lacks $entry" >&2; exit 1; }
            done

            ${postPack}
          '';
    };
}
