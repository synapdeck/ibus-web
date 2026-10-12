// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Schema } from "effect";
import { nonEmpty } from "./schemas.ts";

const count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
// The name becomes a directory and a database name, so it must be one path component that can't
// climb out of its parent or hide itself.
const moduleName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/));
const storePath = Schema.String.check(
  Schema.isPattern(/^\/nix\/store\/[0-9abcdfghijklmnpqrsvwxyz]{32}-[A-Za-z0-9+._?=-]+$/),
);

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

// The module's lazy data: every store path some engine names as its own. The rest is base data, installed at start.
export const lazyStorePaths = (manifest: { readonly engines: readonly EngineDescriptor[] }): ReadonlySet<string> =>
  new Set(manifest.engines.flatMap((engine) => engine.data ?? []));

export const ModuleManifest = Schema.Struct({
  name: moduleName,
  version: nonEmpty,
  license: nonEmpty,
  runtimeAbi: count,
  protocol: count,
  module: Schema.Struct({ url: nonEmpty, size: count }),
  memory: count.check(Schema.isMultipleOf(65536)),
  threads: count,
  data: Schema.Array(
    Schema.Struct({
      storePath,
      url: nonEmpty,
      size: count,
      encoding: Schema.Literals(["br", "identity"]),
    }),
  ),
  settingsSchemaDir: Schema.String,
  // The first engine is the module's default.
  engines: Schema.Array(EngineDescriptor).check(Schema.isNonEmpty()),
  settingsSchemas: Schema.Array(Schema.String),
  settingsMetadata: Schema.optionalKey(Schema.Struct({ url: nonEmpty, size: count })),
}).check(
  Schema.makeFilter((manifest) => {
    const names = manifest.engines.map((engine) => engine.name);
    if (new Set(names).size !== names.length) return "duplicate engine names";

    const paths = manifest.data.map((entry) => entry.storePath);
    if (new Set(paths).size !== paths.length) return "duplicate data store paths";
    for (const engine of manifest.engines) {
      const own = engine.data ?? [];
      if (new Set(own).size !== own.length) return `engine ${engine.name} names a data store path twice`;
      const outside = own.find((path) => !paths.includes(path));
      if (outside !== undefined) return `engine ${engine.name}'s data ${outside} is not in the module's data`;
    }
    const components = manifest.settingsSchemaDir.split("/").slice(1);
    if (components.some((component) => component === "" || component === "." || component === ".."))
      return "schema directory must be a canonical store path";
    // Init reads the schemas before any engine is made, so they must be installed at start.
    for (const path of lazyStorePaths(manifest))
      if (manifest.settingsSchemaDir.startsWith(`${path}/`))
        return `schema directory is in ${path}, which installs only with an engine`;
    return (
      paths.some((path) => manifest.settingsSchemaDir.startsWith(`${path}/`)) ||
      "schema directory is outside the data closure"
    );
  }),
);

export type ModuleManifest = typeof ModuleManifest.Type;

export const decodeModuleManifest = (
  json: unknown,
  bounds: { readonly minimum: number; readonly maximum: number },
): ModuleManifest =>
  Schema.decodeUnknownSync(
    ModuleManifest.check(
      Schema.makeFilter(
        (manifest) =>
          (manifest.memory >= bounds.minimum && manifest.memory <= bounds.maximum) ||
          "memory is outside the runtime bounds",
      ),
    ),
    // A misspelled key would otherwise be dropped silently and its field read as missing or default.
    { onExcessProperty: "error" },
  )(json);
