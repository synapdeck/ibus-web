// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Emscripten's minimum browser and Node versions, from what
// baseline-browser-mapping reports.
//
//   minimum-versions.ts date <timeline.js>
//     Prints the date, as YYYY-MM-DD, the package's data was last updated.
//
//   minimum-versions.ts versions <versions.json> <link-flags>
//     Reads the CLI's report of the browsers Baseline covers from standard
//     input and writes each minimum, raised to its floor (a JSON object in
//     the environment's `floors`), with Node's (`nodeMinimum`), as JSON and
//     as Emscripten's -sMIN_*_VERSION flags.

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

interface Found {
  browser: string;
  version: string;
}

const date = async (timeline: string) => {
  const { lastUpdated } = (await import(pathToFileURL(timeline).href)) as { lastUpdated: number };
  console.log(new Date(lastUpdated).toISOString().slice(0, 10));
};

const versions = (json: string, linkFlags: string) => {
  // The CLI prints the array as Node inspects it, which is a JavaScript
  // expression rather than JSON.
  const found = vm.runInNewContext(`(${readFileSync(0, "utf8")})`) as Found[];
  const encode = (version: string) => {
    const [major, minor = 0, patch = 0] = version.split(".").map(Number);
    if (![major, minor, patch].every(Number.isInteger)) {
      throw new Error(`unreadable version ${version}`);
    }
    return major * 10000 + minor * 100 + patch;
  };
  const versionOf = (browser: string) => {
    const entries = found.filter((entry) => entry.browser === browser);
    if (entries.length !== 1) {
      throw new Error(`expected one ${browser} version, found ${entries.length}`);
    }
    return entries[0].version;
  };
  const baseline: Record<string, number> = {
    chrome: Number(versionOf("chrome")),
    firefox: Number(versionOf("firefox")),
    safari: encode(versionOf("safari")),
    node: Number(process.env.nodeMinimum),
  };
  const minimums = { ...baseline };
  if (process.env.floors === undefined) throw new Error("floors isn't set");
  const floors = JSON.parse(process.env.floors) as Record<string, number>;
  for (const [browser, floor] of Object.entries(floors)) {
    if (!(browser in minimums)) throw new Error(`a floor for unknown ${browser}`);
    minimums[browser] = Math.max(minimums[browser], floor);
  }
  for (const [browser, version] of Object.entries(minimums)) {
    if (!Number.isInteger(version)) throw new Error(`unreadable ${browser} version`);
  }
  writeFileSync(json, `${JSON.stringify(minimums, null, 2)}\n`);
  writeFileSync(
    linkFlags,
    `${Object.entries(minimums)
      .map(([browser, version]) => `-sMIN_${browser.toUpperCase()}_VERSION=${version}`)
      .join(" ")}\n`,
  );
};

const [command, ...args] = process.argv.slice(2);
if (command === "date" && args.length === 1) {
  await date(args[0]);
} else if (command === "versions" && args.length === 2) {
  versions(args[0], args[1]);
} else {
  console.error(
    "usage: minimum-versions.ts date <timeline.js>\n       minimum-versions.ts versions <versions.json> <link-flags>",
  );
  process.exit(1);
}
