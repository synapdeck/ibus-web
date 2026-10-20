#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { errorMessage } from "@ibus-web/protocol";
import { Data, Effect } from "effect";
import { buildModule, inlineMap, relocatedSourceMap, withoutMapComment } from "./build.ts";

const usage = `Usage: ibus-web-module build <script> --out <dir>

Builds a bundled module script into <dir>: manifest.json, module.<hash>.js and,
for a module with settings, settings.json.
`;

class UsageError extends Data.TaggedError("UsageError")<{ readonly problem: string }> {}

class ScriptNotRead extends Data.TaggedError("ScriptNotRead")<{ readonly path: string; readonly reason: string }> {}

interface BuildCommand {
  readonly script: string;
  readonly out: string;
}

// `--out <dir>` or `--out=<dir>`, and the script, in either order.
const parseBuild = (args: readonly string[]): Effect.Effect<BuildCommand, UsageError> =>
  Effect.gen(function* () {
    const positional: string[] = [];
    let out: string | undefined;

    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!;
      if (arg === "--out") {
        out = args[++index];
        if (out === undefined) return yield* new UsageError({ problem: "--out needs a directory" });
      } else if (arg.startsWith("--out=")) {
        out = arg.slice("--out=".length);
      } else if (arg.startsWith("-")) {
        return yield* new UsageError({ problem: `unknown option ${arg}` });
      } else {
        positional.push(arg);
      }
    }

    if (positional.length !== 1) return yield* new UsageError({ problem: "build takes one script" });
    if (out === undefined || out === "") return yield* new UsageError({ problem: "--out is required" });
    return { script: positional[0]!, out };
  });

// The map the script's comment names, inlined or in a file beside it, its
// sources made relative to `out`. A map file that isn't there is left out;
// one that isn't JSON is passed on for the build to refuse.
const mapOf = (script: string, bytes: Uint8Array, out: string): Effect.Effect<Uint8Array | undefined> =>
  Effect.promise(async () => {
    const { url } = withoutMapComment(new TextDecoder().decode(bytes));
    if (url === undefined) return undefined;

    const map =
      inlineMap(url) ??
      (/^[A-Za-z][\w+.-]*:/.test(url)
        ? undefined
        : await readFile(resolve(dirname(script), decodeURIComponent(url))).catch(() => undefined));
    if (map === undefined) return undefined;

    try {
      return relocatedSourceMap(map, relative(out, dirname(script)).replaceAll("\\", "/"));
    } catch {
      return map;
    }
  });

const program = (argv: readonly string[]): Effect.Effect<number> => {
  if (argv.includes("--help") || argv.includes("-h")) return Effect.sync(() => (process.stdout.write(usage), 0));

  return Effect.gen(function* () {
    if (argv[0] !== "build") return yield* new UsageError({ problem: "the command is build" });

    const { script, out } = yield* parseBuild(argv.slice(1));
    const bytes = yield* Effect.tryPromise({
      try: () => readFile(script),
      catch: (error) => new ScriptNotRead({ path: script, reason: errorMessage(error) }),
    });

    // Each refusal's tag names the check, and its message the engine or key
    // and the reason. A decoder's message spans lines, which are joined to
    // keep a refusal to one.
    const sourceMap = yield* mapOf(script, bytes, out);
    return yield* buildModule({ script: bytes, outDir: out, ...(sourceMap === undefined ? {} : { sourceMap }) }).pipe(
      Effect.map(({ manifest }) => {
        process.stdout.write(`Built ${out}: ${manifest.version}\n`);
        return 0;
      }),
      Effect.catch((error) =>
        Effect.sync(() => {
          process.stderr.write(`${script}: ${error._tag}: ${error.message.replace(/\s*\n\s*/g, " ")}\n`);
          return 1;
        }),
      ),
    );
  }).pipe(
    Effect.catchTag("UsageError", ({ problem }) =>
      Effect.sync(() => {
        process.stderr.write(`${problem}\n\n${usage}`);
        return 2;
      }),
    ),
    Effect.catchTag("ScriptNotRead", ({ path, reason }) =>
      Effect.sync(() => {
        process.stderr.write(`${path} can't be read: ${reason}\n`);
        return 1;
      }),
    ),
  );
};

process.exitCode = await Effect.runPromise(program(process.argv.slice(2)));
