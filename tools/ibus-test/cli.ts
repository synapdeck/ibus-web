// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { validateTrace } from "./trace.ts";
import { validateNativeConfig, withNativeSession } from "./session.ts";

const { values } = parseArgs({
  options: {
    "native-config": { type: "string" },
    trace: { type: "string" },
    artifacts: { type: "string" },
  },
});
if (!values["native-config"] || !values.trace || !values.artifacts) {
  throw new Error("usage: cli.ts --native-config CONFIG.json --trace TRACE.json --artifacts DIRECTORY");
}
const config = validateNativeConfig(JSON.parse(readFileSync(values["native-config"], "utf8")));
const trace = validateTrace(JSON.parse(readFileSync(values.trace, "utf8")));
const controller = new AbortController();
const interrupt = () => controller.abort();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
  const result = await withNativeSession(config, trace.settings, (session) => session.run(trace), {
    artifactDir: values.artifacts,
    signal: controller.signal,
  });
  process.stdout.write(result.rawTranscript);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode ?? 1;
} catch (error) {
  process.stderr.write(`${String(error)}\nArtifacts: ${values.artifacts}\n`);
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
