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
            node --input-type=module -e '
              const { lastUpdated } = await import(process.argv[1]);
              console.log(new Date(lastUpdated).toISOString().slice(0, 10));
            ' "$timeline" > $out/date
            # The CLI prints the array as Node inspects it, which is a
            # JavaScript expression rather than JSON.
            baseline-browser-mapping --suppress-warnings --widely-available-on-date "$(< $out/date)" |
              node -e '
                const { readFileSync, writeFileSync } = require("node:fs");
                const vm = require("node:vm");
                const found = vm.runInNewContext(`(''${readFileSync(0, "utf8")})`);
                const encode = (version) => {
                  const [major, minor = 0, patch = 0] = version.split(".").map(Number);
                  if (![major, minor, patch].every(Number.isInteger)) {
                    throw new Error(`unreadable version ''${version}`);
                  }
                  return major * 10000 + minor * 100 + patch;
                };
                const versionOf = (browser) => {
                  const entries = found.filter((entry) => entry.browser === browser);
                  if (entries.length !== 1) {
                    throw new Error(`expected one ''${browser} version, found ''${entries.length}`);
                  }
                  return entries[0].version;
                };
                const baseline = {
                  chrome: Number(versionOf("chrome")),
                  firefox: Number(versionOf("firefox")),
                  safari: encode(versionOf("safari")),
                  node: Number(process.env.nodeMinimum),
                };
                const minimums = { ...baseline };
                for (const [browser, floor] of Object.entries(JSON.parse(process.env.floors))) {
                  if (!(browser in minimums)) throw new Error(`a floor for unknown ''${browser}`);
                  minimums[browser] = Math.max(minimums[browser], floor);
                }
                for (const [browser, version] of Object.entries(minimums)) {
                  if (!Number.isInteger(version)) throw new Error(`unreadable ''${browser} version`);
                }
                writeFileSync(process.argv[1], `''${JSON.stringify(minimums, null, 2)}\n`);
                writeFileSync(
                  process.argv[2],
                  `''${Object.entries(minimums)
                    .map(([browser, version]) => `-sMIN_''${browser.toUpperCase()}_VERSION=''${version}`)
                    .join(" ")}\n`,
                );
              ' $out/versions.json $out/link-flags
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
