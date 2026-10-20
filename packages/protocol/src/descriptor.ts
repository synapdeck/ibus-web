// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// An engine's descriptor, apart from the manifest's codecs: a module script that describes its engines bundles this
// file and Effect's Schema, and nothing else of the protocol.

import { Schema } from "effect";
import { nonEmpty, storePath } from "./strings.ts";

export const EngineDescriptor = Schema.Struct({
  name: nonEmpty,
  displayName: nonEmpty,
  languages: Schema.Array(Schema.String),
  keyboard: Schema.Struct({ layout: Schema.Literals(["us", "default"]), passThrough: Schema.Array(Schema.String) }),
  // Store paths of the module's data that this engine needs and the module's start doesn't: installed before the
  // engine is first made.
  data: Schema.optionalKey(Schema.Array(storePath)),
});

export type EngineDescriptor = typeof EngineDescriptor.Type;
