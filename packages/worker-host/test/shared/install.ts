// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The install scenarios: hosts sharing one engine's storage, as tabs of one
// origin, or Node hosts given one directory, do, installing its data at
// start. Each scenario has an engine, and so storage and locks, of its own.

import { expect } from "vitest";
import type { CollectReport, EngineManifest, InstallReport } from "../../src/shared/messages.ts";
import {
  encodeComponent,
  engineDataDatabase,
  engineDataDir,
  engineDataLock,
  engineInstallLock,
  engineWriterLock,
} from "../../src/shared/naming.ts";
import type { Client } from "./client.ts";
import type { Harness, HostOptions, LaunchedHost, RunningHost, RuntimeBuild, TestArchive } from "./harness.ts";
import { LOCK_RELEASE_LIMIT_MS } from "./locks.ts";
import { call32, errno, opsOf, round } from "./scenarios.ts";
import { engineFor, replyFile, withData } from "./storage.ts";
import type { Message } from "./testing.ts";

const encoder = new TextEncoder();

const installOf = (messages: readonly Message[]): InstallReport | undefined =>
  messages.find((message): message is { type: "install" } & InstallReport => message.type === "install");

const collectOf = (messages: readonly Message[]): CollectReport | undefined => {
  const found = messages.find((message): message is { type: "collect" } & CollectReport => message.type === "collect");
  if (found === undefined) return undefined;
  const { type: _, ...report } = found;
  return report;
};

// The bytes the host feeds the extractor at a time.
const INSTALL_PIECE = 65536;

// The text as a regular expression matches it.
const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The regular files an archive's listing holds, and their bytes.
const counts = ({ listing }: TestArchive): { files: number; bytes: number } => {
  const sizes = listing
    .split("\n")
    .map((line) => /^[^\t]*\tf (\d+) /.exec(line))
    .flatMap((match) => (match === null ? [] : [Number(match[1])]));
  return { files: sizes.length, bytes: sizes.reduce((sum, size) => sum + size, 0) };
};

// The host found the engine's data in state, the archive's.
const expectInstall = (messages: readonly Message[], state: InstallReport["state"], archive: TestArchive): void => {
  expect(installOf(messages), "the install report").toMatchObject({
    state,
    version: archive.version,
    ...counts(archive),
  });
};

// The engine's installed tree as the host sees it, listed by list-tree.
const treeOf = async (h: Harness, client: Client, engine: EngineManifest): Promise<string | number> => {
  const reply = replyFile(await client.call(opsOf(h).listTree, encoder.encode(engineDataDir(engine, engine.data[0]!))));
  return reply.text ?? reply.status;
};

const expectTree = async (
  h: Harness,
  client: Client,
  engine: EngineManifest,
  archive: TestArchive,
  what = "the installed tree",
): Promise<void> => {
  expect(await treeOf(h, client, engine), what).toBe(archive.listing);
};

// The engine's next version, whose data is the upgrade archive.
const upgradeOf = (h: Harness, engine: EngineManifest): EngineManifest => withData(engine, h.data.archives.upgrade);

// Runs the scenario, terminating every host it started once it is done.
const withHosts = async (
  h: Harness,
  runtime: RuntimeBuild,
  run: (launch: (engine: EngineManifest, more?: Partial<HostOptions>) => LaunchedHost) => Promise<void>,
): Promise<void> => {
  const started: LaunchedHost[] = [];
  try {
    await run((engine, more = {}) => {
      const host = h.launch({ runtime, engine, storage: h.storage(engine), ...more });
      started.push(host);
      return host;
    });
  } finally {
    await Promise.all(started.map((host) => host.terminate()));
  }
};

// Polls until a message matches, failing once limitMs has passed or the
// host failed to start.
const waitFor = async <T extends Message>(
  h: Harness,
  host: LaunchedHost,
  match: (message: Message) => message is T,
  what: string,
  limitMs = 30_000,
): Promise<T> => {
  let failed: unknown;
  host.ready.catch((error: unknown) => {
    failed = error;
  });
  const deadline = h.now() + limitMs;
  for (;;) {
    const found = host.messages.find(match);
    if (found !== undefined) return found;
    if (failed !== undefined) throw new Error(`${what}: the host failed to start: ${String(failed)}`);
    if (h.now() >= deadline) throw new Error(`${what}: not in ${limitMs} ms`);
    await h.sleep(10);
  }
};

const stalled = (message: Message): message is { type: "stalled"; bytes: number } => message.type === "stalled";

// Launches a host that stops for good halfway through installing the
// archive, and waits until it has.
// The host stops at the first 64 KiB piece boundary at or past halfway, so
// the archive must span more than two pieces for that to fall short of its
// end.
const stalledHost = async (
  h: Harness,
  launch: (engine: EngineManifest, more?: Partial<HostOptions>) => LaunchedHost,
  engine: EngineManifest,
  archive: TestArchive,
): Promise<LaunchedHost> => {
  expect(archive.size, `${archive.archive}'s size`).toBeGreaterThan(2 * INSTALL_PIECE);
  const host = launch(engine, { test: { stallAt: Math.floor(archive.size / 2) } });
  const { bytes } = await waitFor(h, host, stalled, "the install stalling");
  expect(bytes, "archive bytes fed before the stall").toBeGreaterThan(0);
  expect(bytes, "archive bytes fed before the stall").toBeLessThan(archive.size);
  return host;
};

// A host terminated while connected to a version's database may still be
// connected when the next host deletes that database: its backend's thread
// can hear the version change before the Worker is gone, and says so.
const terminatedHostMayClose = async (h: Harness, database: string): Promise<void> => {
  if (h.storageMount !== "indexeddb") return;
  const closed = await h.printed.take(new RegExp(`^wasmfs-idb: ${literal(database)} closed for a version change$`), {
    min: 0,
    waitMs: 0,
  });
  expect(closed.length, `lines saying ${database} closed`).toBeLessThanOrEqual(1);
};

// Whether the lock comes free within the page's bound: a terminated Worker
// lets go of its locks once it is gone, which in a browser is after
// terminate() returns.
const expectFreed = async (h: Harness, name: string): Promise<void> => {
  expect(await h.locks.released(name), `${name} free within ${LOCK_RELEASE_LIMIT_MS} ms`).toBe(true);
};

// A host starting on storage that holds nothing installs the engine's data
// before it is ready, and the tree is the archive's.
export const installFresh = (h: Harness, runtime: RuntimeBuild): Promise<void> =>
  withHosts(h, runtime, async (launch) => {
    const engine = engineFor(h, "install-fresh", runtime);
    const host = await launch(engine).ready;
    expectInstall(host.messages, "installed", h.data.archives.tree);
    await expectTree(h, host.client, engine, h.data.archives.tree);
  });

// A host started after another installed the engine's data finds the marker
// and skips the install, and reads the same tree.
export const installSkip = (h: Harness, runtime: RuntimeBuild): Promise<void> =>
  withHosts(h, runtime, async (launch) => {
    const engine = engineFor(h, "install-skip", runtime);
    const first = await launch(engine).ready;
    expectInstall(first.messages, "installed", h.data.archives.tree);
    await first.terminate();
    const second = await launch(engine).ready;
    expectInstall(second.messages, "present", h.data.archives.tree);
    await expectTree(h, second.client, engine, h.data.archives.tree);
  });

// Of two hosts started at once on empty storage, one installs the engine's
// data and the other waits on the install lock until the first lets it go,
// then finds the marker and skips; both read the archive's tree.
export const installConcurrent = (h: Harness, runtime: RuntimeBuild): Promise<void> =>
  withHosts(h, runtime, async (launch) => {
    const engine = engineFor(h, "install-concurrent", runtime);
    const hosts = await Promise.all([launch(engine).ready, launch(engine).ready]);
    const reports = hosts.map(({ messages }) => installOf(messages));
    const states = reports.map((report) => report?.state);
    expect(states.toSorted(), "the hosts' install states").toEqual(["installed", "present"]);
    const installed = reports[states.indexOf("installed")]!;
    const present = reports[states.indexOf("present")]!;
    h.record("install-concurrent", { lockTakenAfterReleaseMs: present.lockedAt - installed.releasedAt });
    expect(present.lockedAt, "the second took the lock").toBeGreaterThanOrEqual(installed.releasedAt);
    for (const host of hosts) await expectTree(h, host.client, engine, h.data.archives.tree);
  });

// A host whose Worker is terminated halfway through installing leaves no
// marker: the next host to start installs again, and the tree is the
// archive's, whole and correct.
export const installInterrupted = (h: Harness, runtime: RuntimeBuild): Promise<void> =>
  withHosts(h, runtime, async (launch) => {
    const engine = engineFor(h, "install-interrupted", runtime);
    const first = await stalledHost(h, launch, engine, h.data.archives.tree);
    await first.terminate();
    const next = await launch(engine).ready;
    expectInstall(next.messages, "installed", h.data.archives.tree);
    await expectTree(h, next.client, engine, h.data.archives.tree);
    await terminatedHostMayClose(h, engineDataDatabase(engine));
  });

// A host already waiting on the install lock when the installing host's
// Worker is terminated halfway gets the lock, installs again, and the tree
// is the archive's. Under Node, a request already queued when the holder's
// Worker is terminated is the case the host's rounds of requests are for.
export const installInterruptedQueued = (h: Harness, runtime: RuntimeBuild): Promise<void> =>
  withHosts(h, runtime, async (launch) => {
    const engine = engineFor(h, "install-interrupted-queued", runtime);
    const first = await stalledHost(h, launch, engine, h.data.archives.tree);
    const second = launch(engine);
    const lock = engineInstallLock(engine);
    await waitFor(
      h,
      second,
      (message): message is { type: "waiting"; lock: string } => message.type === "waiting" && message.lock === lock,
      `the second host waiting on ${lock}`,
    );
    await first.terminate();
    const host = await second.ready;
    expectInstall(host.messages, "installed", h.data.archives.tree);
    await expectTree(h, host.client, engine, h.data.archives.tree);
    await terminatedHostMayClose(h, engineDataDatabase(engine));
  });

// A host terminated halfway through installing a tree with entries the
// version's archive lacks leaves them behind for no one: the next host
// empties the version's storage first, and the tree is exactly the
// archive's. The interrupted host installs, under the same version, the
// upgrade archive, whose README is a directory with a file in it, where the
// version's own archive has a file.
export const installInterruptedStray = (h: Harness, runtime: RuntimeBuild): Promise<void> =>
  withHosts(h, runtime, async (launch) => {
    const engine = engineFor(h, "install-interrupted-stray", runtime);
    const { upgrade } = h.data.archives;
    const stray: EngineManifest = {
      ...engine,
      data: engine.data.map((data) => ({ ...data, url: upgrade.url, size: upgrade.size })),
    };
    const first = await stalledHost(h, launch, stray, upgrade);
    await first.terminate();
    const next = await launch(engine).ready;
    expectInstall(next.messages, "installed", h.data.archives.tree);
    await expectTree(h, next.client, engine, h.data.archives.tree);
    await terminatedHostMayClose(h, engineDataDatabase(engine));
  });

// A marker that doesn't parse, as a write cut short leaves it, counts as
// none: the next host installs again, and the tree is the archive's.
export const installTornMarker = (h: Harness, runtime: RuntimeBuild): Promise<void> =>
  withHosts(h, runtime, async (launch) => {
    const engine = engineFor(h, "install-torn-marker", runtime);
    const first = await launch(engine).ready;
    expectInstall(first.messages, "installed", h.data.archives.tree);
    await first.terminate();
    await h.tearMarker(engine);
    const second = await launch(engine).ready;
    expectInstall(second.messages, "installed", h.data.archives.tree);
    await expectTree(h, second.client, engine, h.data.archives.tree);
    await terminatedHostMayClose(h, engineDataDatabase(engine));
  });

// With a host of one version running, a host of the next installs that
// version's data apart, leaves the first's alone since it is in use, and the
// first still reads its own tree; once the first is gone, the next host to
// start deletes its version's data.
export const upgradeWhileRunning = (h: Harness, runtime: RuntimeBuild): Promise<void> =>
  withHosts(h, runtime, async (launch) => {
    const engine = engineFor(h, "upgrade-while-running", runtime);
    const next = upgradeOf(h, engine);
    const { tree, upgrade } = h.data.archives;
    const oldVersion = encodeComponent(engine.version);
    const nextVersion = encodeComponent(next.version);
    const old = await launch(engine).ready;
    expectInstall(old.messages, "installed", tree);
    const upgrading = await launch(next).ready;
    expectInstall(upgrading.messages, "installed", upgrade);
    await expectTree(h, old.client, engine, tree, "the old version's tree after the upgrade");
    await expectTree(h, upgrading.client, next, upgrade, "the upgraded tree");
    expect(collectOf(upgrading.messages), "what the upgrading host collected").toEqual({
      removed: [],
      inUse: [oldVersion],
    });
    await old.terminate();
    await expectFreed(h, engineDataLock(engine, oldVersion));
    const later = await launch(next).ready;
    expectInstall(later.messages, "present", upgrade);
    expect(collectOf(later.messages), "what the later host collected").toEqual({ removed: [oldVersion], inUse: [] });
    await expectTree(h, later.client, next, upgrade);
    expect(await h.versions(engine), "the versions kept").toEqual([nextVersion]);
    await terminatedHostMayClose(h, engineDataDatabase(engine));
  });

// A host of the next version terminated halfway through installing leaves
// the installed version as it was: a host of that version started next finds
// it present, reads its tree whole, and deletes the next version's partial
// data.
export const interruptedUpgradeThenOld = (h: Harness, runtime: RuntimeBuild): Promise<void> =>
  withHosts(h, runtime, async (launch) => {
    const engine = engineFor(h, "interrupted-upgrade-then-old", runtime);
    const next = upgradeOf(h, engine);
    const first = await launch(engine).ready;
    expectInstall(first.messages, "installed", h.data.archives.tree);
    await first.terminate();
    const upgrading = await stalledHost(h, launch, next, h.data.archives.upgrade);
    await upgrading.terminate();
    const partial = encodeComponent(next.version);
    await expectFreed(h, engineDataLock(engine, partial));
    const old = await launch(engine).ready;
    expectInstall(old.messages, "present", h.data.archives.tree);
    expect(collectOf(old.messages), "what the old version's host collected").toEqual({
      removed: [partial],
      inUse: [],
    });
    await expectTree(h, old.client, engine, h.data.archives.tree);
    expect(await h.versions(engine), "the versions kept").toEqual([encodeComponent(engine.version)]);
    await terminatedHostMayClose(h, engineDataDatabase(next));
  });

// The listings' paths that the upgrade drops, and those it turns from a file
// into a directory.
const changes = (from: TestArchive, to: TestArchive): { dropped: string[]; turned: string[] } => {
  const entries = (archive: TestArchive) =>
    new Map(
      archive.listing
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => {
          const [path = "", kind = ""] = line.split("\t");
          return [path, kind.startsWith("d") ? "d" : "f"] as const;
        }),
    );
  const before = entries(from);
  const after = entries(to);
  return {
    dropped: [...before.keys()].filter((path) => !after.has(path)),
    turned: [...before].flatMap(([path, kind]) => (kind === "f" && after.get(path) === "d" ? [path] : [])),
  };
};

// Installing the next version over storage holding the last leaves none of
// the last's files: one the next archive drops is absent, and one it turns
// into a directory is a directory; the tree is the next archive's.
export const staleFile = (h: Harness, runtime: RuntimeBuild): Promise<void> =>
  withHosts(h, runtime, async (launch) => {
    const { tree, upgrade } = h.data.archives;
    const { dropped, turned } = changes(tree, upgrade);
    expect(dropped, "paths the upgrade drops").not.toEqual([]);
    expect(turned, "files the upgrade turns into directories").not.toEqual([]);
    const engine = engineFor(h, "stale-file", runtime);
    const next = upgradeOf(h, engine);
    const first = await launch(engine).ready;
    expectInstall(first.messages, "installed", tree);
    await first.terminate();
    const upgrading = await launch(next).ready;
    expectInstall(upgrading.messages, "installed", upgrade);
    const listed = String(await treeOf(h, upgrading.client, next));
    const lines = listed.split("\n");
    const has = (path: string, kind: "d" | "f"): boolean => lines.some((line) => line.startsWith(`${path}\t${kind}`));
    expect(
      dropped.filter((path) => has(path, "f") || has(path, "d")),
      "dropped paths present",
    ).toEqual([]);
    expect(
      turned.filter((path) => !has(path, "d")),
      "turned paths not directories",
    ).toEqual([]);
    expect(listed, "the upgraded tree").toBe(upgrade.listing);
    await terminatedHostMayClose(h, engineDataDatabase(engine));
  });

// The locks a host of the engine may hold.
const engineLocks = (engine: EngineManifest): string[] => [
  engineInstallLock(engine),
  engineDataLock(engine, encodeComponent(engine.version)),
  engineWriterLock(engine),
];

// A host whose start fails, here for an archive that isn't there, stays
// alive to say why and lets go of every engine lock it took, the writer lock
// included; the next host installs, deleting the version's database first,
// which closes the failed host's connection to it.
export const failedInstallReleasesLocks = (h: Harness, runtime: RuntimeBuild): Promise<void> =>
  withHosts(h, runtime, async (launch) => {
    const engine = engineFor(h, "failed-start-releases-locks", runtime);
    const broken: EngineManifest = {
      ...engine,
      data: engine.data.map((data) => ({ ...data, url: h.data.archives.missing })),
    };
    const failing = launch(broken);
    await expect(failing.ready, "the failed start").rejects.toThrow(
      `host: Error: fetch ${h.data.archives.missing}: 404`,
    );
    for (const name of engineLocks(engine)) await expectFreed(h, name);
    const next = await launch(engine).ready;
    expectInstall(next.messages, "installed", h.data.archives.tree);
    await expectTree(h, next.client, engine, h.data.archives.tree);
    if (h.storageMount === "indexeddb")
      await h.printed.take(
        new RegExp(`^wasmfs-idb: ${literal(engineDataDatabase(engine))} closed for a version change$`),
        {
          count: 1,
        },
      );
  });

// With IndexedDB, a file written under the engine's data directory fails
// with EROFS, on the host that installed the data and on one that found it
// present, and the tree stays the archive's. The Node backend has no
// read-only mode, so under Node the writes are recorded, not judged.
export const dataReadOnly = (h: Harness, runtime: RuntimeBuild): Promise<void> =>
  withHosts(h, runtime, async (launch) => {
    const engine = engineFor(h, "data-read-only", runtime);
    const dir = engineDataDir(engine, engine.data[0]!);
    const write = (client: Client): Promise<number> =>
      call32(client, opsOf(h).writeFile, encoder.encode(`${dir}/written.txt\0x`));
    const installing = await launch(engine).ready;
    expectInstall(installing.messages, "installed", h.data.archives.tree);
    const installingWrote = await write(installing.client);
    const present = await launch(engine).ready;
    expectInstall(present.messages, "present", h.data.archives.tree);
    const presentWrote = await write(present.client);
    h.record("data-read-only", { installingWrote, presentWrote });
    if (h.storageMount !== "indexeddb") return;
    expect(installingWrote, "the installing host's write").toBe(-errno(h, "EROFS"));
    expect(presentWrote, "the present host's write").toBe(-errno(h, "EROFS"));
    await expectTree(h, present.client, engine, h.data.archives.tree);
  });

// A deletion of the version's database that a connection ignoring requests
// to close keeps blocked fails the start once the delete limit has passed,
// saying so, and the failed host lets go of every lock; once that
// connection closes, the next host installs. Browsers only.
export const blockedDeletion = (h: Harness, runtime: RuntimeBuild): Promise<void> =>
  withHosts(h, runtime, async (launch) => {
    if (h.holdDataDatabase === undefined) throw new Error("this environment has no IndexedDB to hold open");
    const engine = engineFor(h, "blocked-deletion", runtime);
    const deleteLimitMs = 500;
    const close = await h.holdDataDatabase(engine);
    try {
      const failing = launch(engine, { config: { deleteLimitMs } });
      await expect(failing.ready, "the failed start").rejects.toThrow(
        `host: Error: deleting ${engineDataDatabase(engine)}: another connection to it stayed open for ${deleteLimitMs} ms after it was asked to close`,
      );
      for (const name of engineLocks(engine)) await expectFreed(h, name);
    } finally {
      close();
    }
    const next = await launch(engine).ready;
    expectInstall(next.messages, "installed", h.data.archives.tree);
    await expectTree(h, next.client, engine, h.data.archives.tree);
  });

// A stray <version>.marking, as a host that stopped while writing its
// marker leaves: of the engine's own version, the next host installs, and
// only the version's directory and its marker are left; of another
// version, collecting removes it. Node only.
export const strayMarking = (h: Harness, runtime: RuntimeBuild): Promise<void> =>
  withHosts(h, runtime, async (launch) => {
    if (h.strayMarking === undefined || h.dataEntries === undefined)
      throw new Error("this environment keeps no markers in files");
    const engine = engineFor(h, "stray-marking", runtime);
    const own = encodeComponent(engine.version);
    const other = encodeComponent("0.9-stray");
    h.storage(engine);
    await h.strayMarking(engine, own);
    await h.strayMarking(engine, other);
    const host = await launch(engine).ready;
    expectInstall(host.messages, "installed", h.data.archives.tree);
    expect(collectOf(host.messages), "what the host collected").toEqual({ removed: [other], inUse: [] });
    expect(await h.dataEntries(engine), "what the data directory holds").toEqual([own, `${own}.installed`]);
    await expectTree(h, host.client, engine, h.data.archives.tree);
  });

// A host waiting on the install lock while another installs slowly keeps
// waiting past the lock limit, since the installer's word keeps arriving,
// and then finds the data present.
export const waitOutlivesLimit = (h: Harness, runtime: RuntimeBuild): Promise<void> =>
  withHosts(h, runtime, async (launch) => {
    const engine = engineFor(h, "wait-outlives-limit", runtime);
    const lockLimitMs = 500;
    const installer = launch(engine, { test: { pieceDelayMs: 100 }, config: { progressIntervalMs: 50 } });
    await installing(h, engine, installer);
    const waiter = launch(engine, { config: { lockLimitMs, lockRoundMs: 100 } });
    const [installed, found] = await Promise.all([installer.ready, waiter.ready]);
    expectInstall(installed.messages, "installed", h.data.archives.tree);
    expectInstall(found.messages, "present", h.data.archives.tree);
    expect(found.messages, "the waiter's messages").toContainEqual({
      type: "waiting",
      lock: engineInstallLock(engine),
    });
    const { lockWaitMs } = installOf(found.messages)!;
    h.record("wait-outlives-limit", { lockWaitMs: round(lockWaitMs, 1) });
    expect(lockWaitMs, "the waiter's wait for the install lock").toBeGreaterThan(lockLimitMs);
    await expectTree(h, found.client, engine, h.data.archives.tree);
  });

// A host waiting on the install lock gives up, failing its start, once the
// lock limit has passed without word from the installer, here one stalled
// for good.
export const waitFailsWithoutProgress = (h: Harness, runtime: RuntimeBuild): Promise<void> =>
  withHosts(h, runtime, async (launch) => {
    const engine = engineFor(h, "wait-fails-without-progress", runtime);
    const lockLimitMs = 500;
    await stalledHost(h, launch, engine, h.data.archives.tree);
    const lock = engineInstallLock(engine);
    const waiter = launch(engine, { config: { lockLimitMs, lockRoundMs: 100 } });
    const failed = expect(waiter.ready, "the waiter's start").rejects.toThrow(
      `host: Error: ${lock}: not granted after ${lockLimitMs} ms without word from the host holding it`,
    );
    await waitFor(
      h,
      waiter,
      (message): message is { type: "waiting"; lock: string } => message.type === "waiting" && message.lock === lock,
      `the waiter waiting on ${lock}`,
    );
    const waitingAt = h.now();
    await failed;
    // The wait starts with the host's first request, a moment before it says
    // it is waiting, so from that message it lasts a little under the limit;
    // the floor catches a waiter that gives up well before the limit.
    expect(h.now() - waitingAt, "how long the waiter waited").toBeGreaterThanOrEqual(lockLimitMs - 50);
  });

// Waits until the host holds the engine's install lock.
const installing = async (h: Harness, engine: EngineManifest, host: LaunchedHost): Promise<void> => {
  const lock = engineInstallLock(engine);
  const deadline = h.now() + 30_000;
  while (await h.locks.free(lock)) {
    if (h.now() >= deadline) throw new Error(`the installer never took ${lock}`);
    await h.sleep(5);
  }
  expect(installOf(host.messages), "the installer's report while it installs").toBeUndefined();
};

// A host that mounts its storage in memory installs the engine's data at
// every start, with no lock to wait for.
export const installedInMemory = async (h: Harness, host: RunningHost, engine: EngineManifest): Promise<void> => {
  expectInstall(host.messages, "installed", h.data.archives.tree);
  expect(installOf(host.messages)?.lockWaitMs, "the wait for a lock").toBe(0);
  expect(collectOf(host.messages), "a collect report").toBeUndefined();
  await expectTree(h, host.client, engine, h.data.archives.tree);
};
