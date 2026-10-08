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
      inherit (config.ibusWeb.engines.table) tables tools;

      # Exactly as printed: key order matters to the comparison.
      descriptors = lib.concatStrings [
        ''[{"name":"latex","displayName":"LaTeX","languages":["und-Zmth"],''
        ''"keyboard":{"layout":"default","passThrough":[]}},''
        ''{"name":"xsampa","displayName":"X-SAMPA","languages":["und-fonipa"],''
        ''"keyboard":{"layout":"default","passThrough":[]}}]''
      ];

      # One per error class, in the order the check runs them.
      errors = pkgs.writeText "ibus-web-table-parse-errors" ''
        bad-layout.table:6: layout must be default or us, not "dvorak"
        bad-mode.table:5: mode must be command or continuous, not "chord"
        bare-trigger.table:8: key is only the trigger
        carriage-return.table:1: carriage return; tables use LF line endings
        empty-key.table:7: empty key
        empty-language.table:4: empty language tag
        empty-output.table:7: empty output
        empty-value.table:3: empty value for "name"
        frontmatter-syntax.table:3: expected key = value
        invalid-utf8.table:1: invalid UTF-8
        key-without-trigger.table:8: key "alpha" doesn't start with the trigger
        long-trigger.table:6: trigger must be one character
        mapping-syntax.table:7: expected key<TAB>output
        missing-key.table:5: missing required key "languages"
        missing-separator.table:5: missing --- after the frontmatter
        missing-trigger.table:6: missing required key "trigger"
        no-mappings.table:7: no mappings
        repeated-continuous-key.table:8: repeated key "a" in continuous mode
        repeated-key.table:4: repeated key "name"
        repeated-mapping.table:9: repeated mapping "\a" to "α"
        space-in-key.table:7: space in key "a b"
        tab-in-output.table:7: tab in output; write it as \t
        trigger-in-continuous.table:6: trigger is only for command mode
        trigger-inside-key.table:8: trigger inside key "\a\b"
        unknown-escape.table:7: unknown escape "\x" in output
        unknown-key.table:4: unknown key "colour"
        missing.table: No such file or directory
      '';
    in
    {
      checks.table-parse =
        pkgs.runCommand "ibus-web-table-parse"
          {
            nativeBuildInputs = [ tools ];
          }
          ''
            export LC_ALL=C

            # The shipped tables parse, and describe their engines.
            [ "$(cd ${tables} && echo *)" = "latex.table xsampa.table" ]
            table-check ${tables}/latex.table ${tables}/xsampa.table

            # \space types a single space. Trimming the output would leave it
            # empty, which the parser rejects, so parsing the table pins it.
            grep -Fx "$(printf '\\space\t ')" ${tables}/latex.table

            describe=$(table-describe ${tables}/latex.table ${tables}/xsampa.table)
            if [ "$describe" != ${lib.escapeShellArg descriptors} ]; then
              echo "unexpected descriptors: $describe" >&2
              exit 1
            fi

            # Each malformed table fails with its message. Bytes that can't be
            # committed as text are written here.
            cp ${./fixtures}/*.table .
            printf 'name = \377\n' > invalid-utf8.table
            printf 'name = Broken\r\n' > carriage-return.table
            for table in *.table missing.table; do
              if table-check "$table" 2>> errors.txt; then
                echo "$table parsed" >&2
                exit 1
              fi
            done
            diff -u ${errors} errors.txt

            mkdir $out
            cp errors.txt $out/
          '';
    };
}
