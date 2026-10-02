// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Scenarios for installing an engine's data at start, which take several
// hosts sharing one engine's storage, as tabs of one origin, or Node hosts
// given one directory, do. Each scenario has an engine, and so storage and
// an install lock, of its own, named after it.

import {
  encodeComponent,
  engineDatabase,
  engineDataDatabasePrefix,
  engineDataDir,
  engineDataLock,
  engineDir,
  engineInstallLock,
  engineWriterLock,
  withData,
  type CollectReport,
  type EngineManifest,
  type HostMessage,
  type InstallReport,
  type TestArchive,
  type TestData,
} from "./control.ts";
import {
  call32,
  replyFile,
  type Client,
  type Env,
  type Measurement,
  type Outcome,
  type Result,
} from "./scenarios.ts";

export interface InstallHost {
  // The host's messages but "ready", as they arrive.
  messages: readonly HostMessage[];
  // Settles once the host is ready, or rejects with why it didn't start.
  ready: Promise<Client>;
  // Settles once the host's Worker is terminated. A browser may let go of
  // its locks only later, so a host the harness starts next for the same
  // engine waits for the engine's writer lock to come free first.
  terminate(): Promise<void>;
}

export interface InstallHarness {
  env: Env;
  // The test archives, and the URLs hosts fetch them from.
  data: TestData;
  dataUrl: string;
  upgradeUrl: string;
  // Starts a host for engine on the storage every host for that engine
  // shares.
  start(
    engine: EngineManifest,
    options?: { installStallAt?: number },
  ): InstallHost;
  // Whether no host holds the lock or waits for it: a request for it,
  // exclusive, is granted at once, and let go.
  lockFree(name: string): Promise<boolean>;
  // The versions, encoded, whose data the engine's storage keeps.
  versions(engine: EngineManifest): Promise<string[]>;
  // Leaves the marker of the engine's version as a write cut short would:
  // a file holding part of it under Node, a value that isn't one in
  // IndexedDB.
  tearMarker(engine: EngineManifest): Promise<void>;
}

export interface InstallScenario {
  name: string;
  criterion: string;
  run(
    harness: InstallHarness,
    engine: EngineManifest,
    started: InstallHost[],
  ): Promise<Outcome>;
}

const round = (value: number): number => Number(value.toFixed(2));

// Far longer than a host takes to start and install, so that a host stuck
// waiting fails its scenario instead of hanging the run.
const READY_LIMIT_MS = 60_000;

const ready = (harness: InstallHarness, host: InstallHost): Promise<Client> =>
  Promise.race([
    host.ready,
    harness.env.sleep(READY_LIMIT_MS).then((): never => {
      throw new Error(`a host wasn't ready in ${READY_LIMIT_MS} ms`);
    }),
  ]);

const installOf = (host: InstallHost): InstallReport | undefined =>
  host.messages.find(
    (message): message is { type: "install" } & InstallReport =>
      message.type === "install" && message.state !== "stalled",
  );

const collectOf = (host: InstallHost): CollectReport | undefined =>
  host.messages.find(
    (message): message is { type: "collect" } & CollectReport =>
      message.type === "collect",
  );

const summary = (report: InstallReport | undefined): string =>
  report === undefined
    ? "no install report"
    : `${report.state} ${report.version}: ${report.bytes} bytes in ${round(report.installMs)} ms, ` +
      `after waiting ${round(report.lockWaitMs)} ms for the lock`;

const collected = (report: CollectReport | undefined): string =>
  report === undefined
    ? "no collect report"
    : `removed [${report.removed.join(", ")}], in use [${report.inUse.join(", ")}]` +
      (report.error === undefined ? "" : `; ${report.error}`);

// The engine's next version, whose data is the upgrade archive.
const upgradeOf = (
  harness: InstallHarness,
  engine: EngineManifest,
): EngineManifest => withData(engine, harness.data.upgrade, harness.upgradeUrl);

// The engine's installed tree as the host sees it, and whether it is
// archive's.
const inspect = async (
  harness: InstallHarness,
  engine: EngineManifest,
  client: Client,
  archive: TestArchive = harness.data,
): Promise<{ pass: boolean; tree: string; text: string | undefined }> => {
  const { env } = harness;
  const dir = engineDataDir(engine, engine.data[0]!);
  const tree = replyFile(
    await client.call(env.ops.listTree, env.utf8(dir)),
    env,
  );
  return {
    pass: tree.text === archive.listing,
    tree:
      tree.text === archive.listing
        ? `${archive.archive}'s`
        : (tree.text ?? `error ${tree.status}`),
    text: tree.text,
  };
};

// Polls until the message arrives, or gives up after limitMs.
const waitForMessage = async <T extends HostMessage>(
  harness: InstallHarness,
  host: InstallHost,
  match: (message: HostMessage) => message is T,
  limitMs: number,
): Promise<T | undefined> => {
  const { env } = harness;
  const deadline = env.now() + limitMs;
  let early = false;
  void host.ready.then(
    () => {},
    () => {
      early = true;
    },
  );
  for (;;) {
    const found = host.messages.find(match);
    if (found !== undefined || early || env.now() >= deadline) return found;
    await env.sleep(10);
  }
};

const LOCK_FREE_LIMIT_MS = 10_000;

// Whether the lock comes free within LOCK_FREE_LIMIT_MS: a Worker that is
// terminated lets go of its locks once it is gone, which in a browser is
// after terminate() returns, and one that lets go of a lock itself does so
// on a channel to the lock manager of its own, which nothing orders with
// the message saying it has.
const whenFree = async (
  harness: InstallHarness,
  name: string,
): Promise<boolean> => {
  const deadline = harness.env.now() + LOCK_FREE_LIMIT_MS;
  for (;;) {
    if (await harness.lockFree(name)) return true;
    if (harness.env.now() >= deadline) return false;
    await harness.env.sleep(10);
  }
};

const STALL_LIMIT_MS = 30_000;

// Starts a host for engine that stalls halfway through installing, and
// waits until it has.
const stalledHost = async (
  harness: InstallHarness,
  engine: EngineManifest,
  started: InstallHost[],
  size: number,
): Promise<{
  host: InstallHost;
  stallAt: number;
  stalled: string;
  bytes?: number;
}> => {
  const stallAt = Math.floor(size / 2);
  const host = harness.start(engine, { installStallAt: stallAt });
  started.push(host);
  const stalled = await waitForMessage(
    harness,
    host,
    (message): message is { type: "install" } & InstallReport =>
      message.type === "install" && message.state === "stalled",
    STALL_LIMIT_MS,
  );
  if (stalled !== undefined)
    return {
      host,
      stallAt,
      stalled: `after ${stalled.bytes} bytes`,
      bytes: stalled.bytes,
    };
  const why = await Promise.race([
    host.ready.then(
      () => "ready, without stalling",
      (error: unknown) => String(error),
    ),
    harness.env.sleep(0).then(() => `no stall in ${STALL_LIMIT_MS} ms`),
  ]);
  return { host, stallAt, stalled: why };
};

const installFresh: InstallScenario = {
  name: "install-fresh",
  criterion:
    "a host starting on storage that holds nothing installs the engine's data before it is " +
    "ready, and the tree is the archive's",
  async run(harness, engine, started): Promise<Outcome> {
    const host = harness.start(engine);
    started.push(host);
    const client = await ready(harness, host);
    const report = installOf(host);
    const seen = await inspect(harness, engine, client);
    return {
      pass: report?.state === "installed" && seen.pass,
      measurements: { install: summary(report), tree: seen.tree },
    };
  },
};

const installSkip: InstallScenario = {
  name: "install-skip",
  criterion:
    "a host started after another installed the engine's data finds the marker and skips " +
    "the install, and reads the same tree",
  async run(harness, engine, started): Promise<Outcome> {
    const first = harness.start(engine);
    started.push(first);
    await ready(harness, first);
    await first.terminate();
    const second = harness.start(engine);
    started.push(second);
    const client = await ready(harness, second);
    const firstReport = installOf(first);
    const secondReport = installOf(second);
    const seen = await inspect(harness, engine, client);
    return {
      pass:
        firstReport?.state === "installed" &&
        secondReport?.state === "present" &&
        seen.pass,
      measurements: {
        first: summary(firstReport),
        second: summary(secondReport),
        tree: seen.tree,
      },
    };
  },
};

const installConcurrent: InstallScenario = {
  name: "install-concurrent",
  criterion:
    "of two hosts started at once on empty storage, one installs the engine's data and the " +
    "other waits on the install lock until the first lets it go, then finds the marker and " +
    "skips; both read the archive's tree",
  async run(harness, engine, started): Promise<Outcome> {
    const hosts = [harness.start(engine), harness.start(engine)];
    started.push(...hosts);
    const clients = await Promise.all(
      hosts.map((host) => ready(harness, host)),
    );
    const reports = hosts.map(installOf);
    const installed = reports.filter((report) => report?.state === "installed");
    const present = reports.filter((report) => report?.state === "present");
    const seen = await Promise.all(
      clients.map((client) => inspect(harness, engine, client)),
    );
    const waited =
      installed.length === 1 &&
      present.length === 1 &&
      present[0]!.lockedAt >= installed[0]!.releasedAt;
    return {
      pass: waited && seen.every(({ pass }) => pass),
      measurements: {
        hosts: reports.map(summary),
        lockTakenAfterRelease:
          installed.length === 1 && present.length === 1
            ? `${present[0]!.lockedAt - installed[0]!.releasedAt} ms after`
            : "no single installer",
        trees: seen.map(({ tree }) => tree),
      },
    };
  },
};

const installInterrupted: InstallScenario = {
  name: "install-interrupted",
  criterion:
    "a host whose Worker is terminated halfway through installing leaves no marker: the next " +
    "host to start installs again, and the tree is the archive's, whole and correct",
  async run(harness, engine, started): Promise<Outcome> {
    const first = await stalledHost(
      harness,
      engine,
      started,
      harness.data.size,
    );
    if (first.bytes === undefined)
      return { pass: false, measurements: { stalled: first.stalled } };
    await first.host.terminate();
    const second = harness.start(engine);
    started.push(second);
    const client = await ready(harness, second);
    const report = installOf(second);
    const seen = await inspect(harness, engine, client);
    return {
      pass:
        first.bytes === first.stallAt &&
        report?.state === "installed" &&
        seen.pass,
      measurements: {
        stalled: first.stalled,
        next: summary(report),
        tree: seen.tree,
      },
    };
  },
};

const WAITING_LIMIT_MS = 30_000;

// Under Node, a request already queued when the holder's Worker is
// terminated is the case the host's rounds of requests are for.
const installInterruptedQueued: InstallScenario = {
  name: "install-interrupted-queued",
  criterion:
    "a host already waiting on the install lock when the installing host's Worker is " +
    "terminated halfway gets the lock, installs again, and the tree is the archive's",
  async run(harness, engine, started): Promise<Outcome> {
    const first = await stalledHost(
      harness,
      engine,
      started,
      harness.data.size,
    );
    if (first.bytes === undefined)
      return { pass: false, measurements: { stalled: first.stalled } };
    const second = harness.start(engine);
    started.push(second);
    const lock = engineInstallLock(engine);
    const waiting = await waitForMessage(
      harness,
      second,
      (message): message is { type: "waiting"; lock: string } =>
        message.type === "waiting" && message.lock === lock,
      WAITING_LIMIT_MS,
    );
    if (waiting === undefined)
      return {
        pass: false,
        measurements: {
          stalled: first.stalled,
          waiting: `the second host never waited on ${lock}`,
        },
      };
    await first.host.terminate();
    const client = await ready(harness, second);
    const report = installOf(second);
    const seen = await inspect(harness, engine, client);
    return {
      pass: report?.state === "installed" && seen.pass,
      measurements: {
        stalled: first.stalled,
        waiting: `on ${waiting.lock}`,
        next: summary(report),
        tree: seen.tree,
      },
    };
  },
};

const upgradeWhileRunning: InstallScenario = {
  name: "upgrade-while-running",
  criterion:
    "with a host of one version running, a host of the next installs that version's data " +
    "apart, leaves the first's alone since it is in use, and the first still reads its own " +
    "tree; once the first is gone, the next host to start deletes its version's data",
  async run(harness, engine, started): Promise<Outcome> {
    const next = upgradeOf(harness, engine);
    const old = harness.start(engine);
    started.push(old);
    const oldClient = await ready(harness, old);
    const upgrading = harness.start(next);
    started.push(upgrading);
    const upgradingClient = await ready(harness, upgrading);
    const oldSeen = await inspect(harness, engine, oldClient);
    const nextSeen = await inspect(
      harness,
      next,
      upgradingClient,
      harness.data.upgrade,
    );
    const oldVersion = encodeComponent(engine.version);
    const nextVersion = encodeComponent(next.version);
    const kept = collectOf(upgrading);
    await old.terminate();
    const freed = await whenFree(harness, engineDataLock(engine, oldVersion));
    const later = harness.start(next);
    started.push(later);
    const laterClient = await ready(harness, later);
    const laterSeen = await inspect(
      harness,
      next,
      laterClient,
      harness.data.upgrade,
    );
    const removed = collectOf(later);
    const versions = await harness.versions(engine);
    return {
      pass:
        installOf(old)?.state === "installed" &&
        installOf(upgrading)?.state === "installed" &&
        installOf(later)?.state === "present" &&
        oldSeen.pass &&
        nextSeen.pass &&
        laterSeen.pass &&
        kept?.inUse.includes(oldVersion) === true &&
        kept.removed.length === 0 &&
        freed &&
        removed?.removed.includes(oldVersion) === true &&
        versions.length === 1 &&
        versions[0] === nextVersion,
      measurements: {
        old: summary(installOf(old)),
        upgrading: summary(installOf(upgrading)),
        upgradingCollected: collected(kept),
        oldTreeAfterUpgrade: oldSeen.tree,
        upgradedTree: nextSeen.tree,
        oldLockFreed: freed,
        later: summary(installOf(later)),
        laterCollected: collected(removed),
        laterTree: laterSeen.tree,
        versionsKept: versions.join(", "),
      },
    };
  },
};

const interruptedUpgradeThenOld: InstallScenario = {
  name: "interrupted-upgrade-then-old",
  criterion:
    "a host of the next version terminated halfway through installing leaves the installed " +
    "version as it was: a host of that version started next finds it present, reads its " +
    "tree whole, and deletes the next version's partial data",
  async run(harness, engine, started): Promise<Outcome> {
    const next = upgradeOf(harness, engine);
    const first = harness.start(engine);
    started.push(first);
    await ready(harness, first);
    await first.terminate();
    const upgrading = await stalledHost(
      harness,
      next,
      started,
      harness.data.upgrade.size,
    );
    if (upgrading.bytes === undefined)
      return { pass: false, measurements: { stalled: upgrading.stalled } };
    await upgrading.host.terminate();
    const partial = encodeComponent(next.version);
    const freed = await whenFree(harness, engineDataLock(engine, partial));
    const old = harness.start(engine);
    started.push(old);
    const client = await ready(harness, old);
    const seen = await inspect(harness, engine, client);
    const collectedByOld = collectOf(old);
    const versions = await harness.versions(engine);
    return {
      pass:
        installOf(first)?.state === "installed" &&
        installOf(old)?.state === "present" &&
        seen.pass &&
        freed &&
        collectedByOld?.removed.includes(partial) === true &&
        versions.length === 1 &&
        versions[0] === encodeComponent(engine.version),
      measurements: {
        first: summary(installOf(first)),
        upgradeStalled: upgrading.stalled,
        partialLockFreed: freed,
        old: summary(installOf(old)),
        oldCollected: collected(collectedByOld),
        tree: seen.tree,
        versionsKept: versions.join(", "),
      },
    };
  },
};

// The listings' paths that the upgrade drops, and those it turns from a
// file into a directory.
const changes = (
  from: TestArchive,
  to: TestArchive,
): { dropped: string[]; turned: string[] } => {
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
    turned: [...before].flatMap(([path, kind]) =>
      kind === "f" && after.get(path) === "d" ? [path] : [],
    ),
  };
};

const staleFile: InstallScenario = {
  name: "stale-file",
  criterion:
    "installing the next version over storage holding the last leaves none of the last's " +
    "files: one the next archive drops is absent, and one it turns into a directory is a " +
    "directory; the tree is the next archive's",
  async run(harness, engine, started): Promise<Outcome> {
    const next = upgradeOf(harness, engine);
    const { dropped, turned } = changes(harness.data, harness.data.upgrade);
    if (dropped.length === 0 || turned.length === 0)
      throw new Error(
        "the upgrade archive must drop a file and turn one into a directory",
      );
    const first = harness.start(engine);
    started.push(first);
    await ready(harness, first);
    await first.terminate();
    const upgrading = harness.start(next);
    started.push(upgrading);
    const client = await ready(harness, upgrading);
    const seen = await inspect(harness, next, client, harness.data.upgrade);
    const lines = new Set((seen.text ?? "").split("\n"));
    const has = (path: string, kind: "d" | "f"): boolean =>
      [...lines].some((line) => line.startsWith(`${path}\t${kind}`));
    const absent = dropped.filter((path) => !has(path, "f") && !has(path, "d"));
    const directories = turned.filter((path) => has(path, "d"));
    return {
      pass:
        installOf(upgrading)?.state === "installed" &&
        seen.pass &&
        absent.length === dropped.length &&
        directories.length === turned.length,
      measurements: {
        upgrading: summary(installOf(upgrading)),
        dropped: `${absent.length} of [${dropped.join(", ")}] absent`,
        turned: `${directories.length} of [${turned.join(", ")}] directories`,
        tree: seen.tree,
      },
    };
  },
};

const failedStartReleasesLocks: InstallScenario = {
  name: "failed-start-releases-locks",
  criterion:
    "a host whose start fails, here for an archive that isn't there, stays alive to say " +
    "why and lets go of every engine lock it took, the writer lock included; the next host installs",
  async run(harness, engine, started): Promise<Outcome> {
    const missing = harness.dataUrl.replace(/[^/]*$/, "missing.tar");
    const broken: EngineManifest = {
      ...engine,
      data: engine.data.map((data) => ({ ...data, url: missing })),
    };
    const failing = harness.start(broken);
    started.push(failing);
    const why = await ready(harness, failing).then(
      () => null,
      (error: unknown) => String(error).split("\n")[0]!,
    );
    const locks = [
      engineInstallLock(engine),
      engineDataLock(engine, encodeComponent(engine.version)),
      engineWriterLock(engine),
    ];
    const free = await Promise.all(
      locks.map((name) => whenFree(harness, name)),
    );
    const next = harness.start(engine);
    started.push(next);
    const client = await ready(harness, next);
    const seen = await inspect(harness, engine, client);
    return {
      pass:
        why?.includes("404") === true &&
        free.every((ok) => ok) &&
        installOf(next)?.state === "installed" &&
        seen.pass,
      measurements: {
        failed: why ?? "started",
        locks: locks.map((name, i) => `${name}: ${free[i] ? "free" : "held"}`),
        next: summary(installOf(next)),
        tree: seen.tree,
      },
    };
  },
};

// Starting from emptied storage is what keeps a file no archive of the
// version has out of its tree: here the interrupted host installs, under
// the same version, the upgrade archive, whose README is a directory with a
// file in it, where the version's own archive has a file.
const installInterruptedStray: InstallScenario = {
  name: "install-interrupted-stray",
  criterion:
    "a host terminated halfway through installing a tree with entries the version's archive " +
    "lacks leaves them behind for no one: the next host empties the version's storage first, " +
    "and the tree is exactly the archive's",
  async run(harness, engine, started): Promise<Outcome> {
    const { upgrade } = harness.data;
    const stray: EngineManifest = {
      ...engine,
      data: engine.data.map((data) => ({
        ...data,
        url: harness.upgradeUrl,
        size: upgrade.size,
      })),
    };
    const first = await stalledHost(harness, stray, started, upgrade.size);
    if (first.bytes === undefined)
      return { pass: false, measurements: { stalled: first.stalled } };
    await first.host.terminate();
    const second = harness.start(engine);
    started.push(second);
    const client = await ready(harness, second);
    const report = installOf(second);
    const seen = await inspect(harness, engine, client);
    return {
      pass: report?.state === "installed" && seen.pass,
      measurements: {
        stalled: `${first.stalled} of ${upgrade.archive}`,
        next: summary(report),
        tree: seen.tree,
      },
    };
  },
};

// The IndexedDB backend refuses changes to marked data, sealed on the host
// that installed it and mounted read-only on the others; the Node backend
// has no read-only mode, so under Node the writes are recorded, not judged.
const dataReadOnly: InstallScenario = {
  name: "data-read-only",
  criterion:
    "with IndexedDB, a file written under the engine's data directory fails with EROFS, on " +
    "the host that installed the data and on one that found it present, and the tree stays " +
    "the archive's",
  async run(harness, engine, started): Promise<Outcome> {
    const { env } = harness;
    const dir = engineDataDir(engine, engine.data[0]!);
    const write = (client: Client): Promise<number> =>
      call32(client, env.ops.writeFile, env.utf8(`${dir}/written.txt\0x`));
    const installing = harness.start(engine);
    started.push(installing);
    const installingWrote = await write(await ready(harness, installing));
    const present = harness.start(engine);
    started.push(present);
    const presentClient = await ready(harness, present);
    const presentWrote = await write(presentClient);
    const seen = await inspect(harness, engine, presentClient);
    const enforced = env.engine?.mount === "indexeddb";
    const refused = -env.errno.EROFS!;
    return {
      pass:
        installOf(installing)?.state === "installed" &&
        installOf(present)?.state === "present" &&
        (!enforced ||
          (installingWrote === refused &&
            presentWrote === refused &&
            seen.pass)),
      measurements: {
        enforced,
        installingHost: installingWrote,
        presentHost: presentWrote,
        expected: enforced ? refused : "not enforced here",
        tree: seen.tree,
      },
    };
  },
};

// Names of storage made from engine names and versions, which may hold any
// character: none runs into another's. Runs no host.
const storageNames: InstallScenario = {
  name: "storage-names",
  criterion:
    "encoded, a name or version has no / or :, and is never . or ..; and engine a/data/x's " +
    "database isn't one of engine a's data databases",
  async run(): Promise<Outcome> {
    const inputs = ["/", ":", ".", "..", "a/b:c", "%2F"];
    const encoded = inputs.map(encodeComponent);
    const safe = encoded.every(
      (text) =>
        !text.includes("/") &&
        !text.includes(":") &&
        text !== "." &&
        text !== "..",
    );
    const distinct = new Set(encoded).size === inputs.length;
    const nested = engineDatabase({ name: "a/data/x", version: "", data: [] });
    const prefix = engineDataDatabasePrefix({
      name: "a",
      version: "",
      data: [],
    });
    return {
      pass: safe && distinct && !nested.startsWith(prefix),
      measurements: {
        encoded: inputs.map((input, i) => `${input} → ${encoded[i]}`),
        nestedEngine: `${nested} against ${prefix}`,
      },
    };
  },
};

const installTornMarker: InstallScenario = {
  name: "install-torn-marker",
  criterion:
    "a marker that doesn't parse, as a write cut short leaves it, counts as none: the next " +
    "host installs again, and the tree is the archive's",
  async run(harness, engine, started): Promise<Outcome> {
    const first = harness.start(engine);
    started.push(first);
    await ready(harness, first);
    await first.terminate();
    await harness.tearMarker(engine);
    const second = harness.start(engine);
    started.push(second);
    const client = await ready(harness, second);
    const report = installOf(second);
    const seen = await inspect(harness, engine, client);
    return {
      pass:
        installOf(first)?.state === "installed" &&
        report?.state === "installed" &&
        seen.pass,
      measurements: {
        first: summary(installOf(first)),
        afterTearing: summary(report),
        tree: seen.tree,
      },
    };
  },
};

// Whether the host reported its user data read-only.
const readOnlyOf = (host: InstallHost): boolean =>
  host.messages.some(
    (message) => message.type === "storage" && message.state === "read-only",
  );

// The IndexedDB backend refuses a reader's writes; the Node backend has no
// read-only mode, so under Node only the lock and the report are judged.
const writerLock: InstallScenario = {
  name: "writer-lock",
  criterion:
    "of two hosts started at once on one engine, exactly one takes the engine's user data's " +
    "writer lock and mounts it read-write; the other reports storage: read-only, and with " +
    "IndexedDB its writes fail with EROFS, while it reads what the writer wrote; once the " +
    "writer's Worker is terminated, a host started next takes the lock and writes",
  async run(harness, engine, started): Promise<Outcome> {
    const { env } = harness;
    const dir = engineDir(engine);
    const enforced = env.engine?.mount === "indexeddb";
    const refused = -env.errno.EROFS!;
    const write = (client: Client, name: string): Promise<number> =>
      call32(client, env.ops.writeFile, env.utf8(`${dir}/${name}\0${name}`));
    const hosts = [harness.start(engine), harness.start(engine)];
    started.push(...hosts);
    const clients = await Promise.all(
      hosts.map((host) => ready(harness, host)),
    );
    const readOnly = hosts.map(readOnlyOf);
    const writers = readOnly.flatMap((ro, i) => (ro ? [] : [i]));
    const wrote = await Promise.all(
      clients.map((client, i) => write(client, `by-${i}.txt`)),
    );
    const measurements: Record<string, Measurement> = {
      enforced,
      readOnly: readOnly.map((ro, i) => `host ${i}: ${ro}`),
      wrote: wrote.map((ret, i) => `host ${i}: ${ret}`),
    };
    if (writers.length !== 1)
      return {
        pass: false,
        measurements: { ...measurements, writers: writers.length },
      };
    const writer = writers[0]!;
    const reader = 1 - writer;
    const fromWriter = `by-${writer}.txt`;
    const readBack = replyFile(
      await clients[reader]!.call(
        env.ops.readFile,
        env.utf8(`${dir}/${fromWriter}`),
      ),
      env,
    );
    measurements.readerReadsWriters = readBack.text ?? readBack.status;

    const terminatedAt = env.now();
    await hosts[writer]!.terminate();
    const next = harness.start(engine);
    started.push(next);
    const nextClient = await ready(harness, next);
    measurements.nextReadyAfterTerminateMs = round(env.now() - terminatedAt);
    const nextWrote = await write(nextClient, "by-next.txt");
    const readerWroteAfter = await write(clients[reader]!, "by-reader.txt");
    measurements.next = `${readOnlyOf(next) ? "read-only" : "read-write"}, wrote ${nextWrote}`;
    measurements.readerAfter = `${readOnlyOf(hosts[reader]!) ? "read-only" : "read-write"}, wrote ${readerWroteAfter}`;
    const length = (name: string): number => env.utf8(name).length;
    return {
      pass:
        wrote[writer] === length(`by-${writer}.txt`) &&
        readBack.text === fromWriter &&
        !readOnlyOf(next) &&
        nextWrote === length("by-next.txt") &&
        (!enforced ||
          (wrote[reader] === refused && readerWroteAfter === refused)),
      measurements,
    };
  },
};

export const installScenarios: readonly InstallScenario[] = [
  installFresh,
  installSkip,
  installConcurrent,
  installInterrupted,
  installInterruptedQueued,
  installInterruptedStray,
  installTornMarker,
  upgradeWhileRunning,
  interruptedUpgradeThenOld,
  staleFile,
  failedStartReleasesLocks,
  dataReadOnly,
  storageNames,
  writerLock,
];

// Runs each scenario on an engine of its own, terminating the hosts it
// started once it is done.
export const runInstallScenarios = async (
  harness: InstallHarness,
  selected: readonly InstallScenario[] = installScenarios,
): Promise<Result[]> => {
  const results: Result[] = [];
  for (const scenario of selected) {
    const engine = withData(
      { name: scenario.name, version: "", data: [] },
      harness.data,
      harness.dataUrl,
    );
    const started: InstallHost[] = [];
    try {
      const { pass, measurements } = await scenario.run(
        harness,
        engine,
        started,
      );
      results.push({
        name: scenario.name,
        criterion: scenario.criterion,
        pass,
        measurements,
      });
    } catch (error) {
      results.push({
        name: scenario.name,
        criterion: scenario.criterion,
        pass: false,
        measurements: {},
        error: String(error),
      });
    } finally {
      await Promise.all(started.map((host) => host.terminate()));
    }
  }
  return results;
};
