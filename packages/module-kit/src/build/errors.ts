// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { Data } from "effect";

/** An import a script makes: its specifier, unless it is computed, and the line it is on. */
export interface ScriptImport {
  readonly specifier: string | undefined;
  readonly line: number;
}

const listed = (imports: readonly ScriptImport[]): string =>
  imports
    .map(
      ({ specifier, line }) =>
        `${specifier === undefined ? "a computed specifier" : JSON.stringify(specifier)} (line ${line})`,
    )
    .join(", ");

/** A script that isn't UTF-8 or that the import scanner can't read as an ES module. */
export class ScriptUnreadable extends Data.TaggedError("ScriptUnreadable")<{
  readonly reason: string;
  readonly message: string;
}> {
  constructor({ reason }: { readonly reason: string }) {
    super({ reason, message: `the script can't be read as an ES module: ${reason}` });
  }
}

/** A script that imports, re-exports from or dynamically imports another module. */
export class ScriptHasImports extends Data.TaggedError("ScriptHasImports")<{
  readonly imports: readonly ScriptImport[];
  readonly message: string;
}> {
  constructor({ imports }: { readonly imports: readonly ScriptImport[] }) {
    super({ imports, message: `the script imports ${listed(imports)}, but a module script must be one file` });
  }
}

/** A script that throws as Node imports it. */
export class ScriptThrew extends Data.TaggedError("ScriptThrew")<{
  readonly reason: string;
  readonly cause: unknown;
  readonly message: string;
}> {
  constructor({ reason, cause }: { readonly reason: string; readonly cause: unknown }) {
    super({ reason, cause, message: `the script throws as it is imported: ${reason}` });
  }
}

/** A source map that isn't a JSON object. */
export class SourceMapUnreadable extends Data.TaggedError("SourceMapUnreadable")<{
  readonly reason: string;
  readonly message: string;
}> {
  constructor({ reason }: { readonly reason: string }) {
    super({ reason, message: `the script's source map can't be read: ${reason}` });
  }
}

/** A default export that isn't a module script, or one the contract refuses. */
export class ModuleRefused extends Data.TaggedError("ModuleRefused")<{
  readonly reason: string;
  readonly message: string;
}> {
  constructor({ reason }: { readonly reason: string }) {
    super({ reason, message: `the script's default export is refused: ${reason}` });
  }
}

/** Settings metadata the page's decoder refuses. */
export class SettingsMetadataRefused extends Data.TaggedError("SettingsMetadataRefused")<{
  readonly reason: string;
  readonly message: string;
}> {
  constructor({ reason }: { readonly reason: string }) {
    super({ reason, message: `the settings metadata is refused: ${reason}` });
  }
}

/** A manifest the host's decoder refuses. */
export class ManifestRefused extends Data.TaggedError("ManifestRefused")<{
  readonly reason: string;
  readonly message: string;
}> {
  constructor({ reason }: { readonly reason: string }) {
    super({ reason, message: `the manifest is refused: ${reason}` });
  }
}

/** An output file that couldn't be written. */
export class WriteFailed extends Data.TaggedError("WriteFailed")<{
  readonly path: string;
  readonly reason: string;
  readonly message: string;
}> {
  constructor({ path, reason }: { readonly path: string; readonly reason: string }) {
    super({ path, reason, message: `${path} can't be written: ${reason}` });
  }
}
