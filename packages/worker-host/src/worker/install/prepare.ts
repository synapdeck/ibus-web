// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Installing an engine's own data, the store paths its descriptor names,
// when the page prepares the engine ahead of making it. Each store path is
// installed under an install lock of its own, so paths install at once, in
// one Worker or several, and within a Worker one install serves every
// engine that needs the path while it runs. Under the lock the host reads
// the path's marker again, since another host may have installed it
// meanwhile; if it is still missing, it installs the path through the
// backend's window, extracting under a staging name and moving the tree
// onto the store path whole, and writes the marker, last. So a reader, an
// engine's thread in this Worker or another Worker's, finds no store path
// or the whole of it, never a tree half-written. An install cut short
// leaves no marker: before the move it leaves a staging tree, which the
// next install of the path removes first; after it, the whole path, which
// the next install marks without extracting it again. A host that mounted
// the version before another installed a path finds the path by lookup,
// since WasmFS keeps only the entries it has found, never an entry's
// absence.

import { errorMessage, type ModuleManifest } from "@ibus-web/protocol";
import type { HostConfigValues } from "../../shared/config.ts";
import type { HostMessage, PathInstallReport } from "../../shared/messages.ts";
import { enginePathInstallLock } from "../../shared/naming.ts";
import type { Instruments } from "../instruments.ts";
import { RuntimeRefused, type RuntimeHandle } from "../runtime.ts";
import type { Held } from "../storage/held.ts";
import { outside, type ArchiveHooks, type DataEntry } from "./archive.ts";
import { installStorePath } from "./staging.ts";
import type { DataStore } from "./store.ts";
import { announce, holdLock } from "./wait.ts";

// What installing into the version's storage takes; a mount in memory has
// installed every store path at start, and has none.
interface Install {
  readonly handle: RuntimeHandle;
  readonly store: DataStore;
  // Runs an extraction with the backend's window open, shared by every
  // extraction that overlaps it.
  readonly window: <T>(install: () => Promise<T>) => Promise<T>;
  readonly held: Held;
  readonly config: HostConfigValues;
  readonly instruments: Instruments;
  readonly hooks: ArchiveHooks;
}

interface Preparing {
  readonly engine: ModuleManifest;
  readonly post: (message: HostMessage) => void;
  readonly install?: Install;
}

// What one store path's install found or did, as its report says it.
type PathOutcome = Omit<PathInstallReport, "engine" | "storePath">;

// One store path's install in this Worker, which every engine that needs
// the path while it runs awaits.
interface PathInstall {
  outcome: Promise<PathOutcome>;
  // The bytes of file data it has written, and who hears them change.
  written: number;
  readonly heard: Set<() => void>;
}

const absent = { lockWaitMs: 0, lockedAt: 0, releasedAt: 0 };

// Installs the store path under its own lock, saying it is still going on
// the lock's channel while it holds it.
const installPath = (
  { handle, store, window, held, config, instruments, hooks }: Install,
  engine: ModuleManifest,
  entry: DataEntry,
  path: PathInstall,
): Promise<PathOutcome> =>
  (async () => {
    const lock = enginePathInstallLock(engine, entry.storePath);
    const granted = await outside(
      lock,
      holdLock(lock, "exclusive", config, () => instruments.waiting(lock), lock),
    );
    held.add(granted.lock);
    const stop = announce(lock, config.progressIntervalMs);
    try {
      const fields = { lockWaitMs: granted.waitMs, lockedAt: granted.lockedAt };
      const marker = await outside(`${entry.storePath}'s marker`, store.pathInstalled(entry.storePath));
      if (marker !== null) return { state: "present", ...marker, installMs: 0, ...fields, releasedAt: Date.now() };
      const startedAt = performance.now();
      const staged = await window(() =>
        installStorePath(handle, engine, entry, {
          ...hooks,
          quiet: store.quiet,
          swept: instruments.swept,
          written: (bytes) => {
            path.written = bytes;
            for (const hear of path.heard) hear();
          },
        }),
      );
      const written = { files: staged.files, bytes: staged.bytes };
      await instruments.beforeMark(entry.storePath);
      await outside(`marking ${entry.storePath}`, store.markPath(entry.storePath, written));
      // Read before letting go, so that a host waiting on the lock can't take
      // it at an earlier time than this.
      return {
        state: "installed",
        ...written,
        installMs: performance.now() - startedAt,
        ...fields,
        releasedAt: Date.now(),
      };
    } finally {
      stop();
      held.release(granted.lock);
    }
  })();

// Prepares the named engines, posting "path-install" for each of an
// engine's store paths, "prepare-progress" while they install, and
// "prepared" last. Several prepares run at once; the promise each returns
// rejects only with what a call into the runtime threw.
export const preparer = ({ engine, post, install }: Preparing): ((name: string) => Promise<void>) => {
  // The store paths this Worker is installing.
  const installing = new Map<string, PathInstall>();

  const start = (entry: DataEntry, worker: Install): PathInstall => {
    const path = { written: 0, heard: new Set() } as unknown as PathInstall;
    path.outcome = installPath(worker, engine, entry, path);
    installing.set(entry.storePath, path);
    const done = (): void => {
      installing.delete(entry.storePath);
    };
    path.outcome.then(done, done);
    return path;
  };

  return async (name) => {
    const prepared = (error?: string): void =>
      post({ type: "prepared", engine: name, ...(error === undefined ? {} : { error }) });
    const report = (storePath: string, outcome: PathOutcome): void =>
      post({ type: "path-install", engine: name, storePath, ...outcome });
    const descriptor = engine.engines.find((candidate) => candidate.name === name);
    if (descriptor === undefined) return prepared(`module ${engine.name} has no engine ${name}`);
    const paths = descriptor.data ?? [];
    if (install === undefined || paths.length === 0) return prepared();
    const entries = paths.map((path) => engine.data.find(({ storePath }) => storePath === path)!);

    try {
      // A path already marked needs no lock: its marker is written last.
      const missing: DataEntry[] = [];
      for (const entry of entries) {
        const marker = installing.has(entry.storePath)
          ? null
          : await outside(`${entry.storePath}'s marker`, install.store.pathInstalled(entry.storePath));
        if (marker === null) missing.push(entry);
        else report(entry.storePath, { state: "present", ...marker, installMs: 0, ...absent });
      }
      if (missing.length === 0) return prepared();

      const total = missing.reduce((sum, { size }) => sum + size, 0);
      const paths = missing.map((entry) => installing.get(entry.storePath) ?? start(entry, install));
      // A path counts its whole size once it is installed, and the bytes it
      // has written until then. Progress reaches total only when every path
      // is installed: a path can have written all of its bytes before its
      // marker, and a failed one keeps what it wrote.
      const installed = new Set<PathInstall>();
      let said = -1;
      const progress = (): void => {
        const bytes = missing.reduce(
          (sum, { size }, i) => sum + (installed.has(paths[i]!) ? size : paths[i]!.written),
          0,
        );
        if (bytes === said || (bytes === total && installed.size < paths.length)) return;
        said = bytes;
        post({ type: "prepare-progress", engine: name, bytes, total });
      };
      progress();
      for (const path of paths) path.heard.add(progress);
      const outcomes = await Promise.allSettled(
        paths.map(async (path) => {
          try {
            const outcome = await path.outcome;
            installed.add(path);
            return outcome;
          } finally {
            progress();
          }
        }),
      );
      for (const path of paths) path.heard.delete(progress);

      let failure: unknown;
      outcomes.forEach((outcome, i) => {
        if (outcome.status === "fulfilled") report(missing[i]!.storePath, outcome.value);
        else if (outcome.reason instanceof RuntimeRefused) failure ??= outcome.reason;
        else throw outcome.reason;
      });
      return prepared(failure === undefined ? undefined : errorMessage(failure));
    } catch (error) {
      if (!(error instanceof RuntimeRefused)) throw error;
      return prepared(errorMessage(error));
    }
  };
};
