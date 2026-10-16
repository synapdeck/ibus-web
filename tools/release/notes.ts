// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// A release's notes, from the changelogs Changesets writes: each package's
// section for the version, under the package's name. A package Changesets
// bumped only to keep the versions together says it has no changes, and is
// left out.

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

export function releaseNotes(version: string, changelogs: readonly Changelog[]): string {
  const parts = [`# ${version}`];
  for (const changelog of changelogs) {
    const body = section(changelog, version);
    if (body === unchanged) continue;
    parts.push(`## ${changelog.name}`, body);
  }
  if (parts.length === 1) throw new Error(`no package changed in ${version}`);
  return parts.join("\n\n") + "\n";
}
