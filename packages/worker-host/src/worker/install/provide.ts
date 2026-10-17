// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Mounts this version's data at /nix/store, installing its base data first
// unless its marker says it is there, then lets other versions' data go.
// The base data is every store path no engine names as its own; those an
// engine names are installed when a page prepares that engine. A mount in
// memory is this host's alone, starts empty and can't grow, so it installs
// every store path at start with no lock. Otherwise the host holds the
// version's data lock, shared, for as long as it runs, and decides and
// installs under its install lock, so that of hosts starting together one
// installs and the others then find the marker. An install cut short leaves
// no marker, and the next host empties the version's storage and installs
// again, so no partial tree and no other version's file survives it, and a
// host using another version never sees its own data change.
//
// Any host may later install a store path of an engine's own into the
// version's storage, so its backend is created with its window for changes
// shut, opened only while the host holds an install lock and runs the
// installer, and sealed for good as the host closes.

import { errorSummary, lazyStorePaths, type ModuleManifest } from "@ibus-web/protocol";
import { Effect, type Scope } from "effect";
import type { HostConfigValues } from "../../shared/config.ts";
import type { CollectReport, HostMessage, InstallReport } from "../../shared/messages.ts";
import { encodeComponent, engineDataLock, engineDataRoot, engineInstallLock } from "../../shared/naming.ts";
import { runtimeCallFailed, runtimeFinalizer, startupFailed, StartupFailed } from "../failure.ts";
import type { Instruments } from "../instruments.ts";
import type { RuntimeHandle } from "../runtime.ts";
import type { Held } from "../storage/held.ts";
import { makeDirs, mountAt } from "../storage/mount.ts";
import type { StoragePlan } from "../storage/plan.ts";
import { requestLock } from "../storage/locks.ts";
import { collectPreloaded } from "../preloaded.ts";
import { installArchives, type ArchiveHooks, type Tally } from "./archive.ts";
import { preparer } from "./prepare.ts";
import { idbStore, nodeStore, sharedWindow, type DataStore } from "./store.ts";
import { holdLock, progressOn } from "./wait.ts";

interface ProvideData {
  readonly handle: RuntimeHandle;
  readonly engine: ModuleManifest;
  readonly plan: StoragePlan;
  readonly idbReadOnly: number;
  readonly held: Held;
  readonly config: HostConfigValues;
  readonly instruments: Instruments;
  readonly post: (message: HostMessage) => void;
}

// What the engine's data is mounted on.
export interface DataMount {
  // Whether its IndexedDB backend's connection has closed under it.
  readonly closed: () => boolean;
  // How many changes to it have failed for want of space.
  readonly quotaFailures: () => number;
  // Installs the named engine's own data where the version's storage lacks
  // it, posting what it does and, last, "prepared". Rejects only with what
  // a call into the runtime threw, which leaves the runtime unfit to call.
  readonly prepare: (engine: string) => Promise<void>;
}

// Deletes the data of every other version no host is using. A host using a
// version holds its data lock shared, so one granted exclusively at once is
// one no host uses, and no host can start using it until it is let go.
// Best-effort: a failure is reported, never thrown. The page's preloads of
// other versions go too, which no host reads.
const collect = async (store: DataStore, engine: ModuleManifest): Promise<CollectReport> => {
  const report: CollectReport = { removed: [], inUse: [] };
  const preloaded = await collectPreloaded(engine);
  if (preloaded !== undefined) report.error = preloaded;
  try {
    for (const version of await store.others()) {
      const lock = await requestLock(engineDataLock(engine, version), { mode: "exclusive", ifAvailable: true });
      if (lock === null) {
        report.inUse.push(version);
        continue;
      }
      try {
        await store.remove(version);
        report.removed.push(version);
      } finally {
        lock.release();
      }
    }
  } catch (error) {
    report.error = report.error === undefined ? errorSummary(error) : `${report.error}; ${errorSummary(error)}`;
  }
  return report;
};

const archiveHooks = (config: HostConfigValues, instruments: Instruments): ArchiveHooks => ({
  idleMs: config.archiveIdleMs,
  forceBrotliFallback: instruments.forceBrotliFallback,
  brotliDecoder: instruments.brotliDecoder,
  fetching: instruments.fetching,
  beforePiece: ({ fed }: Tally) => instruments.beforePiece(fed),
});

export const provideData = ({
  handle,
  engine,
  plan,
  idbReadOnly,
  held,
  config,
  instruments,
  post,
}: ProvideData): Effect.Effect<DataMount, StartupFailed, Scope.Scope> =>
  Effect.gen(function* () {
    if (engine.version === "")
      return yield* new StartupFailed({ message: `engine ${engine.name}'s manifest has no version` });
    const root = engineDataRoot(engine);
    const startedAt = performance.now();
    const report = (state: InstallReport["state"], fields: Omit<InstallReport, "state" | "version" | "installMs">) =>
      post({ type: "install", state, version: engine.version, ...fields, installMs: performance.now() - startedAt });

    if (plan.mount === "memory" || plan.mount === "none") {
      const lockedAt = Date.now();
      const tally = yield* Effect.tryPromise({
        try: () => {
          makeDirs(handle, root);
          return installArchives(handle, engine, engine.data, archiveHooks(config, instruments));
        },
        catch: runtimeCallFailed,
      });
      report("installed", {
        files: tally.files,
        bytes: tally.bytes,
        lockWaitMs: 0,
        lockedAt,
        releasedAt: Date.now(),
      });
      const preloaded = yield* Effect.promise(() => collectPreloaded(engine));
      if (preloaded !== undefined) post({ type: "collect", removed: [], inUse: [], error: preloaded });
      return { closed: () => false, quotaFailures: () => 0, prepare: preparer({ engine, post }) };
    }

    const lazy = lazyStorePaths(engine);
    const base = engine.data.filter(({ storePath }) => !lazy.has(storePath));
    const hold = (name: string, mode: LockMode, progress?: string) =>
      Effect.tryPromise({
        try: () => holdLock(name, mode, config, () => instruments.waiting(name), progress),
        catch: startupFailed,
      }).pipe(Effect.tap(({ lock }) => Effect.sync(() => held.add(lock))));
    yield* hold(engineDataLock(engine, encodeComponent(engine.version)), "shared");
    // Sealed as the host closes, while the runtime can still be called,
    // whether its start failed or it ran.
    let seal: (() => void) | undefined;
    yield* runtimeFinalizer(Effect.sync(() => seal?.()));
    const installLock = engineInstallLock(engine);
    const { store, window, marker, found, waitMs, lockedAt, releasedAt } = yield* Effect.gen(function* () {
      const { waitMs, lockedAt } = yield* Effect.acquireRelease(
        hold(installLock, "exclusive", installLock),
        ({ lock }) => Effect.sync(() => held.release(lock)),
      );
      yield* progressOn(installLock, config.progressIntervalMs);

      yield* Effect.try({ try: () => makeDirs(handle, "/nix"), catch: runtimeCallFailed });
      const store: DataStore = yield* plan.mount === "node"
        ? Effect.tryPromise({ try: () => nodeStore(handle, engine, plan.hostPath), catch: startupFailed })
        : Effect.succeed(idbStore(handle, engine, idbReadOnly, config.deleteLimitMs));
      const marker = yield* Effect.tryPromise({ try: () => store.installed(), catch: startupFailed });
      if (marker === null) yield* Effect.tryPromise({ try: () => store.clear(), catch: startupFailed });
      yield* Effect.try({ try: () => mountAt(handle, store.backend(), root, plan.mount), catch: runtimeCallFailed });
      seal = store.seal;
      const window = sharedWindow(store, instruments.window);
      let found = marker;
      if (found === null) {
        const tally = yield* Effect.tryPromise({
          try: () => window(() => installArchives(handle, engine, base, archiveHooks(config, instruments))),
          catch: runtimeCallFailed,
        });
        found = { version: engine.version, files: tally.files, bytes: tally.bytes };
        const marked = found;
        yield* Effect.tryPromise({ try: () => store.mark(marked), catch: startupFailed });
      }
      // Read before letting go, so that a host waiting on the lock can't take
      // it at an earlier time than this.
      const releasedAt = Date.now();
      return { store, window, marker, found, waitMs, lockedAt, releasedAt };
    }).pipe(Effect.scoped);
    report(marker === null ? "installed" : "present", {
      files: found.files,
      bytes: found.bytes,
      lockWaitMs: waitMs,
      lockedAt,
      releasedAt,
    });
    post({ type: "collect", ...(yield* Effect.promise(() => collect(store, engine))) });
    return {
      closed: () => store.closed(),
      quotaFailures: () => store.quotaFailures(),
      prepare: preparer({
        engine,
        post,
        install: { handle, store, window, held, config, instruments, hooks: archiveHooks(config, instruments) },
      }),
    };
  });
