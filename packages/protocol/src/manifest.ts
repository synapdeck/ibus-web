// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Schema } from "effect";
import { EngineDescriptor } from "./descriptor.ts";
import { nonEmpty, storePath } from "./strings.ts";

const count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
// The name becomes a directory and a database name, so it must be one path component that can't
// climb out of its parent or hide itself.
const moduleName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/));
// SHA-256, in lowercase hexadecimal, of the runtime's ABI number and the
// libraries it carries: their names, versions and exported symbols.
const runtimeIdentity = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));

// The module's lazy data: every store path some engine names as its own. The rest is base data, installed at start.
export const lazyStorePaths = (manifest: { readonly engines: readonly EngineDescriptor[] }): ReadonlySet<string> =>
  new Set(manifest.engines.flatMap((engine) => engine.data ?? []));

const uniqueEngineNames = (manifest: { readonly engines: readonly EngineDescriptor[] }): string | undefined => {
  const names = manifest.engines.map((engine) => engine.name);
  return new Set(names).size === names.length ? undefined : "duplicate engine names";
};

// The module's descriptors in order; the first is the module's default.
const engines = Schema.Array(EngineDescriptor).check(Schema.isNonEmpty());
const asset = Schema.Struct({ url: nonEmpty, size: count });

// A manifest without `kind` is a WebAssembly module.
export const WasmModuleManifest = Schema.Struct({
  kind: Schema.optionalKey(Schema.Literal("wasm")),
  name: moduleName,
  version: nonEmpty,
  license: nonEmpty,
  runtimeAbi: count,
  runtimeIdentity,
  protocol: count,
  module: asset,
  memory: count.check(Schema.isMultipleOf(65536)),
  threads: count,
  data: Schema.Array(
    Schema.Struct({
      storePath,
      url: nonEmpty,
      size: count,
      // The entries the archive installs: its directories, files and links, each of which takes memory of its own
      // beside its data where the data is installed in memory.
      files: count,
      encoding: Schema.Literals(["br", "identity"]),
    }),
  ),
  settingsSchemaDir: Schema.String,
  engines,
  settingsSchemas: Schema.Array(Schema.String),
  settingsMetadata: Schema.optionalKey(asset),
}).check(
  Schema.makeFilter((manifest) => {
    const duplicate = uniqueEngineNames(manifest);
    if (duplicate !== undefined) return duplicate;

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

export type WasmModuleManifest = typeof WasmModuleManifest.Type;

// A module written in JavaScript: one self-contained ES module script and no runtime, memory or data of its own.
export const JsModuleManifest = Schema.Struct({
  kind: Schema.Literal("js"),
  name: moduleName,
  version: nonEmpty,
  license: nonEmpty,
  protocol: count,
  // The version of the contract between the host and the script's exports.
  moduleAbi: count,
  module: asset,
  engines,
  settingsSchemas: Schema.Array(Schema.String),
  settingsMetadata: Schema.optionalKey(asset),
}).check(
  Schema.makeFilter((manifest) => {
    const duplicate = uniqueEngineNames(manifest);
    if (duplicate !== undefined) return duplicate;

    const withData = manifest.engines.find((engine) => engine.data !== undefined);
    return withData === undefined || `engine ${withData.name} names data, which a JavaScript module can't have`;
  }),
);

export type JsModuleManifest = typeof JsModuleManifest.Type;

export const ModuleManifest = Schema.Union([WasmModuleManifest, JsModuleManifest]);

export type ModuleManifest = typeof ModuleManifest.Type;

export const decodeModuleManifest = (
  json: unknown,
  bounds: { readonly minimum: number; readonly maximum: number },
): ModuleManifest =>
  Schema.decodeUnknownSync(
    ModuleManifest.check(
      Schema.makeFilter(
        (manifest) =>
          manifest.kind === "js" ||
          (manifest.memory >= bounds.minimum && manifest.memory <= bounds.maximum) ||
          "memory is outside the runtime bounds",
      ),
    ),
    // A misspelled key would otherwise be dropped silently and its field read as missing or default.
    { onExcessProperty: "error" },
  )(json);
