// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { Data } from "effect";

/** What a refused definition names: the engine and the setting where there is one, and what is wrong. */
export interface ModuleDefinitionErrorFields {
  /** The engine's name in its module. */
  readonly engine?: string;
  /** The setting's name as its settings struct writes it. */
  readonly key?: string;
  readonly reason: string;
}

const describe = ({ engine, key, reason }: ModuleDefinitionErrorFields): string => {
  const setting = key === undefined ? undefined : `setting ${JSON.stringify(key)}`;

  if (engine === undefined) return setting === undefined ? reason : `the ${setting} ${reason}`;
  return `the engine ${JSON.stringify(engine)}${setting === undefined ? "" : `'s ${setting}`} ${reason}`;
};

/**
 * A module or engine definition the kit refuses, thrown while the script is imported. It is never a `TypeError`, which
 * the host would take for a failed fetch.
 */
export class ModuleDefinitionError extends Data.TaggedError("ModuleDefinitionError")<
  ModuleDefinitionErrorFields & { readonly message: string }
> {
  constructor(fields: ModuleDefinitionErrorFields) {
    super({ ...fields, message: describe(fields) });
  }
}
