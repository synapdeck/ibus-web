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
      inherit (config.ibusWeb) baselineBrowserMapping;
      inherit (config.ibusWeb.typescript) nodejs;

      # Emscripten writes a version as one number, two decimal digits each
      # for the minor version and the patch: Node 24.19.0 is 241900.
      nodeMinimum =
        let
          parts = map lib.toInt (lib.splitString "." nodejs.version);
          part = n: if n < builtins.length parts then builtins.elemAt parts n else 0;
        in
        toString ((part 0) * 10000 + (part 1) * 100 + part 2);

      # Versions below which a browser's minimum never goes, whatever
      # Baseline covers. A floor only ever raises the minimum; once Baseline
      # reaches it, it has no effect. Firefox: indexedDB.databases(), which
      # the host lists other versions' engine data with, is in Firefox 126
      # and later; 124 and 125 together are some 0.02% of users. A floor is
      # written as its browser's minimum is: Safari's as major * 10000 +
      # minor * 100 + patch, the others as a major version.
      floors = {
        firefox = 126;
      };

      # The browsers are those Baseline Widely available covers on the date
      # baseline-browser-mapping's data was last updated, so the result moves
      # only when the package does, never with the build machine's clock,
      # raised to the floors.
      minimumVersions =
        pkgs.runCommand "ibus-web-emscripten-minimum-versions"
          {
            nativeBuildInputs = [
              baselineBrowserMapping
              nodejs
            ];
            timeline = "${baselineBrowserMapping.src}/src/data/timeline.js";
            floors = builtins.toJSON floors;
            inherit nodeMinimum;
          }
          ''
            mkdir $out
            node ${./minimum-versions.ts} date "$timeline" > $out/date
            baseline-browser-mapping --suppress-warnings --widely-available-on-date "$(< $out/date)" |
              node ${./minimum-versions.ts} versions $out/versions.json $out/link-flags
          '';
    in
    {
      ibusWeb.toolchain = {
        inherit minimumVersions;
        minimumVersionFlags = "$(< ${minimumVersions}/link-flags)";
      };
      legacyPackages.emscriptenMinimumVersions = minimumVersions;
    };
}
