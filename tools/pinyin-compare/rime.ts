// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** A Rime session's state after a command, as rime-session prints it. */
export interface RimeState {
  readonly input: string | null;
  /** What committing now would give: the selected text, the first candidate, then any input left raw. */
  readonly preview: string | null;
  readonly candidate: string | null;
  readonly commit: string | null;
}

export type RimeCommand = `type ${string}` | "select" | "clear";

export interface RimeSession {
  send(command: RimeCommand): Promise<RimeState>;
}

/**
 * Converts pinyin as a user taking the first candidate each time would: the
 * keys, then the first candidate; while that covers only part of the input,
 * it is selected and the next first candidate taken. The last candidate is
 * read from the preview rather than selected, and the composition cleared,
 * so nothing is committed and Rime learns nothing from one sentence to the
 * next.
 */
export async function convertWithRime(session: RimeSession, pinyin: string): Promise<string> {
  if (!/^[a-z]+$/.test(pinyin)) {
    throw new Error(`rime: ${JSON.stringify(pinyin)} isn't lowercase letters alone`);
  }

  let state = await session.send(`type ${pinyin}`);
  try {
    // Each selection uses at least one key of the input.
    for (let selections = 0; selections <= pinyin.length; selections++) {
      if (state.commit !== null) {
        return state.commit;
      }
      // Input left raw shows in the preview as its letters.
      if (state.candidate === null || !/[a-z]/.test(state.preview ?? "")) {
        return state.preview ?? "";
      }
      state = await session.send("select");
    }
    throw new Error(`rime: ${pinyin} took more selections than it has keys`);
  } finally {
    await session.send("clear");
  }
}

/** A running rime-session process. */
export interface RimeProcess extends RimeSession {
  close(): Promise<void>;
}

export async function spawnRimeSession(
  program: string,
  sharedDir: string,
  userDir: string,
  schema: string,
): Promise<RimeProcess> {
  const child = spawn(program, [sharedDir, userDir, schema], { stdio: ["pipe", "pipe", "inherit"] });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();

  const next = async (): Promise<unknown> => {
    const line = await lines.next();
    if (line.done === true) {
      throw new Error(`rime-session exited with ${await exited}`);
    }
    return JSON.parse(line.value);
  };

  const ready = (await next()) as { schema?: unknown };
  if (ready.schema !== schema) {
    throw new Error(`rime-session started in ${JSON.stringify(ready.schema)}, not ${schema}`);
  }

  return {
    async send(command) {
      child.stdin.write(`${command}\n`);
      return (await next()) as RimeState;
    },
    async close() {
      child.stdin.end();
      const status = await exited;
      if (status !== 0) {
        throw new Error(`rime-session exited with ${status}`);
      }
    },
  };
}
