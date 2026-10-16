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
      inherit (config.ibusWeb) typescript;

      # The last commit to change unicode.xml when it was pinned: Unicode 18.
      unicodeXml = pkgs.fetchurl {
        name = "unicode.xml";
        url = "https://raw.githubusercontent.com/w3c/xml-entities/0f766d761eebd0908b4f2cfaa30cf9b06bdc79b0/unicode.xml";
        hash = "sha256-itRCuTYOpD87oHBPAzxObbTBU1YYSDjQAKSsEhgvuTU=";
      };

      generator = "${typescript.workspaceFor [ "tools/latex-table" ]}/tools/latex-table";
    in
    {
      # The LaTeX table is unicode.xml's data.
      ibusWeb.release.engines.table.extraSources = [ unicodeXml ];

      ibusWeb.engines.table.tables =
        pkgs.runCommand "ibus-web-table-tables"
          {
            nativeBuildInputs = [ typescript.nodejs ];
            # latex.table is unicode.xml's data; xsampa.table is ours.
            meta.license = with lib.licenses; [
              w3c
              mit
              asl20
            ];
          }
          ''
            mkdir $out
            node ${generator}/cli.ts ${unicodeXml} ${generator}/aliases.tsv > $out/latex.table
            cp ${./tables/xsampa.table} $out/xsampa.table
          '';
    };
}
