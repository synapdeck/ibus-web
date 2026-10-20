// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { extname, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { errorMessage } from "@ibus-web/protocol";
import { Data, Effect } from "effect";
import {
  buildModuleFiles,
  relocatedSourceMap,
  withoutMapComment,
  type BuildModuleFilesError,
  type BuiltModule,
} from "../build/build.ts";

/** An `outDir` that doesn't name a directory inside the bundler's output. */
export class OutDirRefused extends Data.TaggedError("OutDirRefused")<{
  readonly outDir: string;
  readonly message: string;
}> {
  constructor({ outDir }: { readonly outDir: string }) {
    super({
      outDir,
      message: `outDir ${JSON.stringify(outDir)} must be a relative path to a directory inside the bundler's output`,
    });
  }
}

/** A build whose output isn't one ES module file. */
export class NotOneFile extends Data.TaggedError("NotOneFile")<{
  readonly files: readonly string[];
  readonly message: string;
}> {
  constructor({ files }: { readonly files: readonly string[] }) {
    super({
      files,
      message:
        files.length === 0
          ? "the build has no entry script, but a module is built from one"
          : `the build gives ${files.join(", ")}, but a module is one ES module file: give it one entry`,
    });
  }
}

/** A build that emits files besides its script, which a module, served as one file, can't reach. */
export class ModuleHasAssets extends Data.TaggedError("ModuleHasAssets")<{
  readonly files: readonly string[];
  readonly message: string;
}> {
  constructor({ files }: { readonly files: readonly string[] }) {
    super({
      files,
      message: `the build emits ${files.join(", ")} besides the script, but a module is one file: inline what it imports`,
    });
  }
}

/** A built module's file, named by its path inside the bundler's output. */
export interface OutputFile {
  readonly fileName: string;
  readonly bytes: Uint8Array;
}

/** What the plugin can refuse a build for. */
export type PluginRefusal = BuildModuleFilesError | OutDirRefused | NotOneFile | ModuleHasAssets;

// A path the bundler would write outside its output directory, or over it,
// is refused rather than normalised into something the author didn't write.
const checkedOutDir = (outDir: string): Effect.Effect<string, OutDirRefused> => {
  const normalised = posix.normalize(outDir.replaceAll("\\", "/")).replace(/\/+$/, "");
  const escapes = normalised === "." || normalised === ".." || normalised.startsWith("../");

  return outDir === "" || posix.isAbsolute(normalised) || /^[A-Za-z]:/.test(normalised) || escapes
    ? Effect.fail(new OutDirRefused({ outDir }))
    : Effect.succeed(normalised);
};

/** A plugin's build: the bundled script, its source map, and where the module's files go. */
export interface ModuleInput {
  readonly script: Uint8Array | string;
  readonly sourceMap?: Uint8Array | string | undefined;
  /** The directory, relative to the bundler's output, that the bundler wrote the script and its map to. */
  readonly from?: string | undefined;
  readonly outDir: string | undefined;
  /** The directory under which a module's files go to `<parent>/<module name>` when no `outDir` is given. */
  readonly parent?: string | undefined;
}

const scriptText = (script: Uint8Array | string): string =>
  typeof script === "string" ? script : new TextDecoder().decode(script);

/**
 * Builds the module from its bundled script and places its files under `outDir`, by default `<parent>/<module name>`,
 * `parent` being `ibus-module` unless given. A source map moved there leads to the same sources.
 */
export const moduleOutput = ({
  script,
  sourceMap,
  from = "",
  outDir,
  parent = "ibus-module",
}: ModuleInput): Effect.Effect<{ readonly built: BuiltModule; readonly files: readonly OutputFile[] }, PluginRefusal> =>
  Effect.gen(function* () {
    // A bundler that writes a map without naming it in the script, as for a
    // hidden map, wants it kept off the page.
    const built = yield* buildModuleFiles({
      script,
      ...(sourceMap === undefined
        ? {}
        : { sourceMap, sourceMapComment: withoutMapComment(scriptText(script)).url !== undefined }),
    });

    const directory = yield* checkedOutDir(outDir ?? posix.join(parent, built.manifest.name));
    const prefix = posix.relative(directory, posix.normalize(from.replaceAll("\\", "/")));

    return {
      built,
      files: built.files.map(({ name, bytes }) => ({
        fileName: `${directory}/${name}`,
        bytes: name.endsWith(".map") ? relocatedSourceMap(bytes, prefix) : bytes,
      })),
    };
  });

/** The line a bundler reports a refusal with: its tag, then its message on one line. */
export const refusalMessage = (error: PluginRefusal): string =>
  `${error._tag}: ${error.message.replace(/\s*\n\s*/g, " ")}`;

/** What a plugin's build gives: the module's name and files, or the message to fail the bundler's build with. */
export type ModuleOutput =
  | { readonly name: string; readonly files: readonly OutputFile[] }
  | { readonly error: string };

/** Runs a plugin's build in this thread. */
export const runModuleOutput = (input: ModuleInput): Promise<ModuleOutput> =>
  Effect.runPromise(
    moduleOutput(input).pipe(
      Effect.match({
        onSuccess: ({ built, files }) => ({ name: built.manifest.name, files }),
        onFailure: (error) => ({ error: refusalMessage(error) }),
      }),
    ),
  );

// Beside this file and with its extension: `.ts` when the kit runs from
// source, `.js` once built.
const workerUrl = new URL(`./build-worker${extname(fileURLToPath(import.meta.url))}`, import.meta.url);

/**
 * Runs a plugin's build in a thread that ends with it. Building imports the script, and Node never releases an imported
 * module, so a watcher or server rebuilding on every edit would otherwise keep every script it built.
 */
export const outputInWorker = (input: ModuleInput): Promise<ModuleOutput> =>
  new Promise<ModuleOutput>((resolve, reject) => {
    const worker = new Worker(workerUrl, { workerData: input });

    worker.once("message", (output: ModuleOutput) => {
      resolve(output);
      void worker.terminate();
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      reject(new Error(`the build's thread exited with code ${code} before giving the module's files`));
    });
  }).catch((error: unknown) => ({ error: errorMessage(error) }));
