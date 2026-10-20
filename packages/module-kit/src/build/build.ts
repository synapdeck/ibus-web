// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import {
  decodeSettingsMetadata,
  encodeSettingsMetadata,
  errorMessage,
  errorSummary,
  JsModuleManifest,
  PROTOCOL_VERSION,
  scriptProblem,
  settingsSchemaIds,
  settingsSchemaPath,
  type GVariantValue,
  type SettingsMetadata,
} from "@ibus-web/protocol";
import { MODULE_ABI, type ModuleScript, type SettingDeclaration } from "@ibus-web/protocol/module-script";
import { Effect, Schema } from "effect";
import { init, parse, ImportType } from "es-module-lexer";
import {
  ManifestRefused,
  ModuleRefused,
  ScriptHasImports,
  ScriptThrew,
  ScriptUnreadable,
  SettingsMetadataRefused,
  SourceMapUnreadable,
  WriteFailed,
  type ScriptImport,
} from "./errors.ts";

/** A file of a built module: its name in the output directory and its bytes. */
export interface ModuleFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** A built module: its manifest, and its files with `manifest.json` last. */
export interface BuiltModule {
  readonly manifest: JsModuleManifest;
  readonly files: readonly ModuleFile[];
}

export interface BuildModuleFilesOptions {
  /** The bundled module script, one ES module file, as its bytes or its source text. */
  readonly script: Uint8Array | string;
  /**
   * The script's source map, as its bytes or its text, written beside the script under the script's name. Unset, a map
   * inlined in the script's `sourceMappingURL` comment is used, if there is one.
   */
  readonly sourceMap?: Uint8Array | string;
  /**
   * Whether the script gets a `sourceMappingURL` comment naming the map. Defaults to true; false keeps a map out of the
   * script for tools that look it up by name, as a bundler's hidden map is.
   */
  readonly sourceMapComment?: boolean;
}

export interface BuildModuleOptions extends BuildModuleFilesOptions {
  /** The directory the files are written to, made if it doesn't exist. */
  readonly outDir: string;
}

/** What building a module's files can be refused for. */
export type BuildModuleFilesError =
  | ScriptUnreadable
  | ScriptHasImports
  | ScriptThrew
  | ModuleRefused
  | SettingsMetadataRefused
  | SourceMapUnreadable
  | ManifestRefused;

/** What building a module into a directory can be refused for. */
export type BuildModuleError = BuildModuleFilesError | WriteFailed;

const encoder = new TextEncoder();

// The first 16 hexadecimal digits of the SHA-256 of the parts, in order.
const hash = (...parts: readonly Uint8Array[]): string => {
  const digest = createHash("sha256");
  for (const part of parts) digest.update(part);
  return digest.digest("hex").slice(0, 16);
};

// Written the same way each time, so that a build of the same script is
// byte-identical.
const json = (value: unknown): Uint8Array => encoder.encode(`${JSON.stringify(value, null, 2)}\n`);

// Semver allows one build metadata section, whose identifiers are separated
// by dots, so a version that has one gets the hash as a further identifier.
const versioned = (version: string, digest: string): string =>
  version.includes("+") ? `${version}.js.${digest}` : `${version}+js.${digest}`;

// A comment naming the script's source map, which bundlers write last. The
// URL is a file's relative path or a `data:` URL holding the map itself.
const mapComment = /(?:^|\r?\n)\/\/[#@] sourceMappingURL=(\S*)\s*$/;

/** The script without a trailing `sourceMappingURL` comment, and the URL the comment gives. */
export const withoutMapComment = (source: string): { readonly code: string; readonly url: string | undefined } => {
  const found = mapComment.exec(source);
  return found === null ? { code: source, url: undefined } : { code: source.slice(0, found.index), url: found[1] };
};

/** The map a `data:` URL holds. */
export const inlineMap = (url: string | undefined): Uint8Array | undefined => {
  const found = url === undefined ? null : /^data:[^,]*?(;base64)?,(.*)$/s.exec(url);
  if (found === null) return undefined;

  const [, base64, data = ""] = found;
  return base64 === undefined ? encoder.encode(decodeURIComponent(data)) : Buffer.from(data, "base64");
};

// The map, naming the script it is served beside.
const namedMap = (map: Uint8Array | string, file: string): Effect.Effect<Uint8Array, SourceMapUnreadable> =>
  Effect.try({
    try: () => {
      const parsed: unknown = JSON.parse(typeof map === "string" ? map : new TextDecoder().decode(map));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("it isn't an object");
      return encoder.encode(JSON.stringify({ ...parsed, file }));
    },
    catch: (error) => new SourceMapUnreadable({ reason: errorMessage(error) }),
  });

/**
 * The map, moved to a directory from which `prefix` leads back to the one it was written in, its relative sources
 * rewritten to lead to the same files.
 */
export const relocatedSourceMap = (map: Uint8Array, prefix: string): Uint8Array => {
  if (prefix === "" || prefix === ".") return map;

  const parsed = JSON.parse(new TextDecoder().decode(map)) as { sourceRoot?: unknown; sources?: unknown };
  const moved = (path: string): string => (/^(?:[A-Za-z][\w+.-]*:|\/)/.test(path) ? path : posix.join(prefix, path));

  // A source root, when the map has one, is what each source is relative to.
  if (typeof parsed.sourceRoot === "string" && parsed.sourceRoot !== "") {
    parsed.sourceRoot = moved(parsed.sourceRoot);
  } else if (Array.isArray(parsed.sources)) {
    parsed.sources = parsed.sources.map((source: unknown) => (typeof source === "string" ? moved(source) : source));
  }

  return encoder.encode(JSON.stringify(parsed));
};

const lineOf = (source: string, offset: number): number => source.slice(0, offset).split("\n").length;

// Every import but import.meta, which reads the script's own URL and fetches
// nothing.
const importsOf = (source: string): Effect.Effect<readonly ScriptImport[], ScriptUnreadable> =>
  Effect.tryPromise({
    try: async () => {
      await init;
      const [imports] = parse(source);
      return imports
        .filter(({ t }) => t !== ImportType.ImportMeta)
        .map(({ n, ss }) => ({ specifier: n, line: lineOf(source, ss) }));
    },
    catch: (error) => new ScriptUnreadable({ reason: errorMessage(error) }),
  });

// Node imports a data: URL as an ES module without a file to write and clean
// up, and the URL is the script's content, so an unchanged script is
// imported once.
const importScript = (bytes: Uint8Array): Effect.Effect<unknown, ScriptThrew> =>
  Effect.tryPromise({
    try: async () => {
      const url = `data:text/javascript;base64,${Buffer.from(bytes).toString("base64")}`;
      const exports = (await import(/* @vite-ignore */ url)) as { readonly default?: unknown };
      return exports.default;
    },
    catch: (cause) => new ScriptThrew({ reason: errorSummary(cause), cause }),
  });

const checkModule = (exported: unknown): Effect.Effect<ModuleScript, ModuleRefused> => {
  const problem = scriptProblem(exported);
  if (problem?._tag === "NotAModule")
    return Effect.fail(new ModuleRefused({ reason: "it isn't an ibus-web module, such as defineModule makes" }));
  if (problem?._tag === "ModuleAbiMismatch")
    return Effect.fail(
      new ModuleRefused({
        reason: `it states the module ABI ${String(problem.abi)}, but this build writes ${MODULE_ABI}`,
      }),
    );
  if (problem !== undefined) return Effect.fail(new ModuleRefused({ reason: problem.reason }));

  const script = exported as ModuleScript;
  for (const field of ["name", "version", "license"] as const)
    if (typeof script[field] !== "string")
      return Effect.fail(new ModuleRefused({ reason: `its ${field} isn't a string` }));
  for (const [name, { descriptor }] of Object.entries(script.engines))
    if (typeof descriptor !== "object" || descriptor === null)
      return Effect.fail(new ModuleRefused({ reason: `its engine ${name} has no descriptor` }));
  return Effect.succeed(script);
};

const listValue = (items: readonly string[]): GVariantValue => ({
  _tag: "a",
  items: items.map((value) => ({ _tag: "s", value })),
});

// A declaration as the settings metadata holds a key, its values typed.
const metadataKey = (name: string, declaration: SettingDeclaration) => {
  const text = {
    ...(declaration.summary === undefined ? {} : { summary: declaration.summary }),
    ...(declaration.description === undefined ? {} : { description: declaration.description }),
  };

  switch (declaration.type) {
    case "b":
      return { name, type: "b", default: { _tag: "b", value: declaration.default } as GVariantValue, ...text };
    case "s":
      return {
        name,
        type: "s",
        default: { _tag: "s", value: declaration.default } as GVariantValue,
        ...text,
        ...(declaration.choices === undefined ? {} : { choices: [...declaration.choices] }),
      };
    case "i":
    case "d": {
      const { type, range } = declaration;
      const number = (value: number): GVariantValue => ({ _tag: type, value });
      return {
        name,
        type,
        default: number(declaration.default),
        ...text,
        ...(range === undefined ? {} : { range: { min: number(range.min), max: number(range.max) } }),
      };
    }
    case "as":
      return { name, type: "as", default: listValue(declaration.default), ...text };
  }
};

// Each engine's settings schema, in the engines' order, its keys in the
// order the engine declares them, which is the order the page's form shows.
const settingsMetadata = (script: ModuleScript): SettingsMetadata | undefined => {
  const schemas = Object.entries(script.engines).flatMap(([engine, { settings }]) => {
    if (settings === undefined) return [];

    const id = `${script.settingsPrefix}.${engine}`;
    return [
      {
        id,
        paths: [settingsSchemaPath(id)],
        keys: Object.entries(settings).map(([key, declaration]) => metadataKey(key, declaration)),
      },
    ];
  });
  return schemas.length === 0 ? undefined : { schemas };
};

const encodedSettings = (script: ModuleScript): Effect.Effect<Uint8Array | undefined, SettingsMetadataRefused> =>
  Effect.try({
    try: () => {
      const metadata = settingsMetadata(script);
      if (metadata === undefined) return undefined;

      const encoded = encodeSettingsMetadata(metadata);
      decodeSettingsMetadata(encoded);
      return json(encoded);
    },
    catch: (error) => new SettingsMetadataRefused({ reason: errorMessage(error) }),
  });

// Decoded by the JavaScript variant of the host's manifest decoder, which
// names only this variant's problems, and refuses unknown keys as the host
// does. The decoder writes the fields in the schema's order, whatever order
// the script gave its descriptors' keys in.
const decodeManifest = Schema.decodeUnknownSync(JsModuleManifest, { onExcessProperty: "error" });

const decodedManifest = (manifest: unknown): Effect.Effect<JsModuleManifest, ManifestRefused> =>
  Effect.try({
    try: () => decodeManifest(manifest),
    catch: (error) => new ManifestRefused({ reason: errorMessage(error) }),
  });

/**
 * Builds a module's files from its bundled script without writing them: `module.<hash>.js`, the script as it is but for
 * a trailing `sourceMappingURL` comment; `module.<hash>.js.map` and, unless `sourceMapComment` is false, a comment
 * naming it when the script has a source map, the hash then covering the map as well as the code; `settings.json` when any engine has settings; and `manifest.json`, its URLs relative to it.
 */
export const buildModuleFiles = ({
  script,
  sourceMap,
  sourceMapComment = true,
}: BuildModuleFilesOptions): Effect.Effect<BuiltModule, BuildModuleFilesError> =>
  Effect.gen(function* () {
    const original = typeof script === "string" ? encoder.encode(script) : script;
    const decoded = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(original),
      catch: () => new ScriptUnreadable({ reason: "it isn't UTF-8" }),
    });

    // The comment is left out of the hashes, since it names a file that is
    // itself named for the hash.
    const { code: source, url } = withoutMapComment(decoded);
    const bytes = url === undefined ? original : encoder.encode(source);

    const imports = yield* importsOf(source);
    if (imports.length > 0) return yield* new ScriptHasImports({ imports });

    const module = yield* checkModule(yield* importScript(bytes));
    const settings = yield* encodedSettings(module);

    // A map can change while the code doesn't, and a name must stand for
    // one set of bytes, so the script's hash covers the map too.
    const map = sourceMap ?? inlineMap(url);
    const mapBytes = typeof map === "string" ? encoder.encode(map) : map;
    const moduleName = `module.${mapBytes === undefined ? hash(bytes) : hash(bytes, mapBytes)}.js`;
    const mapFile =
      map === undefined ? undefined : { name: `${moduleName}.map`, bytes: yield* namedMap(map, moduleName) };
    const served =
      mapFile === undefined || !sourceMapComment
        ? bytes
        : Buffer.concat([bytes, encoder.encode(`\n//# sourceMappingURL=${mapFile.name}\n`)]);

    const manifest = yield* decodedManifest({
      kind: "js",
      name: module.name,
      version: versioned(module.version, settings === undefined ? hash(bytes) : hash(bytes, settings)),
      license: module.license,
      protocol: PROTOCOL_VERSION,
      moduleAbi: MODULE_ABI,
      module: { url: `./${moduleName}`, size: served.length },
      engines: Object.entries(module.engines).map(([name, { descriptor }]) => ({ ...descriptor, name })),
      settingsSchemas: settingsSchemaIds(module),
      ...(settings === undefined ? {} : { settingsMetadata: { url: "./settings.json", size: settings.length } }),
    });

    return {
      manifest,
      files: [
        { name: moduleName, bytes: served },
        ...(mapFile === undefined ? [] : [mapFile]),
        ...(settings === undefined ? [] : [{ name: "settings.json", bytes: settings }]),
        { name: "manifest.json", bytes: json(manifest) },
      ],
    };
  });

/**
 * Builds a module from its bundled script into `outDir`, as `buildModuleFiles` does, and writes its files there. The
 * manifest is written last, so that one on disk never names a file not yet written.
 */
export const buildModule = ({ outDir, ...options }: BuildModuleOptions): Effect.Effect<BuiltModule, BuildModuleError> =>
  Effect.gen(function* () {
    const built = yield* buildModuleFiles(options);

    yield* Effect.tryPromise({
      try: () => mkdir(outDir, { recursive: true }),
      catch: (error) => new WriteFailed({ path: outDir, reason: errorMessage(error) }),
    });
    for (const { name, bytes } of built.files) {
      const path = join(outDir, name);
      yield* Effect.tryPromise({
        try: () => writeFile(path, bytes),
        catch: (error) => new WriteFailed({ path, reason: errorMessage(error) }),
      });
    }
    return built;
  });
