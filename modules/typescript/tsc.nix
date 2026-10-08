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
      inherit (config.ibusWeb.typescript) nodejs nodeModules;

      # The lockfile resolves typescript to one version, whichever packages
      # depend on it.
      tsc = pkgs.runCommand "ibus-web-tsc" { nativeBuildInputs = [ pkgs.makeWrapper ]; } ''
        packages=(${nodeModules}/node_modules/.pnpm/typescript@*/node_modules/typescript)
        if [ ''${#packages[@]} -ne 1 ] || [ ! -d "''${packages[0]}" ]; then
          echo "expected one typescript in the workspace, found: ''${packages[*]}" >&2
          exit 1
        fi
        makeWrapper ${lib.getExe nodejs} $out/bin/tsc --add-flags "''${packages[0]}/bin/tsc"
      '';
    in
    {
      ibusWeb.typescript = { inherit tsc; };

      devshells.default.packages = [ tsc ];
    };
}
