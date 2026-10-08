// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// What a distribution's build asks of the protocol package's build, given
// the path of its entry point: the protocol version a manifest names, and
// whether the manifest it wrote decodes, as hosts will decode it.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

interface Protocol {
  PROTOCOL_VERSION: number;
  decodeModuleManifest(manifest: unknown, memory: { minimum: number; maximum: number }): unknown;
}

const usage = "usage: protocol.ts version PROTOCOL.js | protocol.ts check PROTOCOL.js MANIFEST.json MINIMUM MAXIMUM";

const [command, entry, manifest, minimum, maximum] = process.argv.slice(2);
if (!entry) throw new Error(usage);
const protocol = (await import(pathToFileURL(entry).href)) as Protocol;
if (command === "version") process.stdout.write(`${protocol.PROTOCOL_VERSION}\n`);
else if (command === "check" && manifest && minimum && maximum)
  protocol.decodeModuleManifest(JSON.parse(readFileSync(manifest, "utf8")), {
    minimum: Number(minimum),
    maximum: Number(maximum),
  });
else throw new Error(usage);
