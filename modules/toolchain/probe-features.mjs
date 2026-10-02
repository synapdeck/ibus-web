// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Reads an `emcc -v` log (run with EMCC_DEBUG, which also prints the
// feature-matrix decisions) and optionally the final settings dump, and prints
// the sorted set of WebAssembly features the tools were told to use. The
// settings dump holds only settings that differ from their defaults, so an
// absent one is reported as <default>.
import { readFileSync } from "node:fs";

const [logPath, settingsPath] = process.argv.slice(2);
const log = readFileSync(logPath, "utf8");

// Settings whose value the minimum versions decide.
const decided = ["GROWABLE_ARRAYBUFFERS", "MEMORY64", "WASM_BIGINT", "WASM_LEGACY_EXCEPTIONS"];

const lines = new Set();

// Only clang's own -cc1 invocation lists the resolved target features.
for (const command of log.matchAll(/^ +"?\/\S*\/(clang\S*|wasm-ld|wasm-opt)"? (.*)$/gm)) {
  const tool = command[1].replace(/^clang.*/, "clang");
  const args = command[2].split(" ");
  for (const [index, arg] of args.entries()) {
    if (/^--(extra-features=|enable-)/.test(arg)) {
      lines.add(`${tool} ${arg}`);
    } else if (arg === "-target-feature") {
      lines.add(`${tool} target-feature ${args[index + 1]}`);
    }
  }
}

if (settingsPath) {
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  for (const name of decided) {
    lines.add(`setting ${name}=${name in settings ? settings[name] : "<default>"}`);
  }
}

for (const line of [...lines].sort()) console.log(line);
