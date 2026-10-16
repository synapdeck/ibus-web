// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// A release's notes, from the changelogs Changesets writes: each package's
// section for the version, under the package's name. The published packages
// always release together, so their dependencies on each other move with
// every release and listing them says nothing: those entries are left out,
// and so is a package whose section has nothing else.

export interface Changelog {
  name: string;
  text: string;
}

const unchanged = "No changes in this release.";

// The lines under `## VERSION`, up to the next section of that level.
export function section(changelog: Changelog, version: string): string {
  const lines = changelog.text.split("\n");
  const start = lines.findIndex((line) => line.trimEnd() === `## ${version}`);
  if (start === -1) throw new Error(`${changelog.name}: its changelog has no section for ${version}`);

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,2} /.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

// A dependency update is one top-level item whose first line names the
// update (changelog-github: "Updated dependencies [...]:", the plain
// changelog: the first dependency itself) and whose nested lines each name
// a dependency at its version.
const dependencyLead = /^- (?:Updated dependencies\b.*|(?:@[\w.-]+\/)?[\w.-]+@\S+)$/;
const dependency = /^\s+- (?:@[\w.-]+\/)?[\w.-]+@\S+$/;

// The section without its dependency updates, nor the headings they leave
// empty.
export function withoutDependencyUpdates(body: string): string {
  const blocks: string[][] = [];
  for (const line of body.split("\n")) {
    if (/^(?:- |#)/.test(line) || blocks.length === 0) blocks.push([line]);
    else blocks.at(-1)!.push(line);
  }

  const kept = blocks.filter((block) => {
    const [lead, ...rest] = block;
    const nested = rest.filter((line) => line.trim() !== "");
    return !(dependencyLead.test(lead!) && nested.every((line) => dependency.test(line)));
  });

  const withItems = kept.filter((block, i) => {
    if (!block[0]!.startsWith("#")) return true;
    const next = kept.slice(i + 1).find((other) => other[0]!.startsWith("- ") || other[0]!.startsWith("#"));
    return next !== undefined && next[0]!.startsWith("- ");
  });

  return withItems
    .map((block) => block.join("\n"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function releaseNotes(version: string, changelogs: readonly Changelog[]): string {
  const parts = [`# ${version}`];
  for (const changelog of changelogs) {
    const body = withoutDependencyUpdates(section(changelog, version));
    if (body === "" || body === unchanged) continue;
    parts.push(`## ${changelog.name}`, body);
  }
  if (parts.length === 1) throw new Error(`no package changed in ${version}`);
  return parts.join("\n\n") + "\n";
}
