// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { tryReconstructAbsoluteUri } from "@microsoft/sarif";
import type { ArtifactLocation, Result, Run, SarifLog } from "@microsoft/sarif";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function readSarif(text: string): SarifLog {
  // Clang emits one JSON line on stderr among emcc messages and a warning count.
  // Also accept standalone, pretty-printed SARIF files.
  for (const candidate of [text, ...text.split("\n")]) {
    let value: SarifLog;
    try {
      value = JSON.parse(candidate) as SarifLog;
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
    if (value?.version === "2.1.0" && Array.isArray(value.runs)) return value;
  }
  throw new Error("compiler output contains no valid SARIF 2.1.0 document");
}

export function castTypes(run: Run, result: Result): { from: string; to: string } | null {
  const rule = run.tool.driver.rules?.[result.ruleIndex ?? -1];
  const name = rule?.name || result.ruleId || "";
  if (name !== "-Wcast-function-type-strict" && !/^\d+$/.test(name)) return null;

  // Clang leaves SARIF rule names empty and exposes internal numeric IDs.
  // This message identifies the diagnostic independently of those unstable IDs.
  const match =
    /^cast from '(.+?)'(?: \(aka '.*?'\))? to '(.+?)'(?: \(aka '.*?'\))? converts to incompatible function type$/.exec(
      result.message.text ?? "",
    );
  if (!match) {
    if (name === "-Wcast-function-type-strict") throw new Error(`unrecognized cast diagnostic: ${result.message.text}`);
    return null;
  }

  const [, from, to] = match;
  if (to === "GCallback" || to === "void (*)(void)") return null;
  return { from, to };
}

export function sourcePath(run: Run, location: ArtifactLocation, root: string): string {
  const indexed = run.artifacts?.[location.index ?? -1]?.location;
  const artifact = { ...indexed, ...location };
  const absolute = tryReconstructAbsoluteUri(artifact, run.originalUriBaseIds);
  if (absolute) return fileURLToPath(absolute);
  if (artifact.uriBaseId || !artifact.uri) throw new Error("cast diagnostic has an unresolved source location");
  return resolve(root, artifact.uri);
}
