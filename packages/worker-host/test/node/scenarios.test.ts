// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The host's scenarios under Node, the host in a worker_thread and this
// thread playing the page. Under Node, Emscripten creates a Worker beyond the
// pool rather than fail a thread's creation, so pool-exhausted runs in
// browsers only.

import { afterAll, afterEach, beforeAll, beforeEach, describe, test } from "vitest";
import type { ModuleManifest } from "@ibus-web/protocol";
import type { HostOptions, RunningHost } from "../shared/harness.ts";
import {
  abortPrinted,
  coldWake,
  crashPrinted,
  crossThreadWake,
  deadline,
  dispatch,
  exceptions,
  glibStress,
  heapFull,
  memStress,
  noLateReplies,
  poolTopUp,
  syncProxied,
  threadCrash,
  threadCreateBlocked,
  threadExitBlocked,
} from "../shared/scenarios.ts";
import { protocolRoundtrip } from "../shared/protocol.ts";
import { failedInstantiate, refusedMemory, relayFailure, released, topUpLimit } from "../shared/lifecycle.ts";
import { engineDir } from "../../src/shared/naming.ts";
import {
  crashReleasesLocks,
  engineFor,
  failedStartReleasesLocks,
  promiseProxiedFsync,
  storageCosts,
  storageFallback,
  storageRoundtrip,
  storedHost,
  trapKeepsWriter,
  writerLock,
} from "../shared/storage.ts";
import {
  dataReadOnly,
  failedInstallReleasesLocks,
  installedInMemory,
  installFresh,
  installSizeMismatch,
  installBrotli,
  installBrokenBrotli,
  installInterrupted,
  installInterruptedQueued,
  installInterruptedStray,
  installSkip,
  installTornMarker,
  interruptedUpgradeThenOld,
  staleFile,
  storeLinks,
  strayMarking,
  upgradeWhileRunning,
  rebuiltDistributionWhileRunning,
  waitFailsWithoutProgress,
  waitOutlivesLimit,
} from "../shared/install.ts";
import {
  fsFailures,
  installLargeFile,
  installLimit,
  installLinksRefused,
  installLongNames,
  installMalformed,
  installModes,
  installOverPartial,
  installRefused,
  installSymlinks,
  installTarget,
  installThroughLinks,
  installWhole,
} from "../shared/installer.ts";
import {
  lazyEngineFor,
  prepareAfterMount,
  prepareConcurrent,
  preparedDistribution,
  preparedInMemory,
  prepareFresh,
  prepareInterrupted,
  prepareMovedUnmarked,
  prepareShared,
  prepareSkip,
  prepareWhole,
  prepareWindowShut,
} from "../shared/prepare.ts";
import { nodeHarness } from "./harness.ts";

const h = await nodeHarness();

beforeEach(() => h.printed.nothingElse());
afterAll(() => h.cleanUp());
afterEach(() => h.printed.nothingElse());

describe.each(h.data.runtimes)("the $name runtime", (runtime) => {
  // In order: thread-create-blocked and pool-top-up need the pool as it
  // started, before any other scenario leaves a thread alive or grows it.
  describe("one host", () => {
    let host: RunningHost;
    beforeAll(async () => {
      host = await h.start({ runtime });
    });
    afterAll(() => host?.terminate());
    afterEach(() => noLateReplies(host.client));

    test("dispatch", () => dispatch(h, host));
    test("cold-wake", () => coldWake(h, host));
    test("thread-create-blocked", () => threadCreateBlocked(h, host));
    test("pool-top-up", () => poolTopUp(h, host));
    test("thread-exit-blocked", () => threadExitBlocked(h, host));
    test("cross-thread-wake", () => crossThreadWake(h, host));
    test("deadline", () => deadline(h, host));
    test("sync-proxied", () => syncProxied(h, host));
    test("exceptions", () => exceptions(h, host));
  });

  // Each of these takes its host down, or needs one of its own.
  const ownHost = async (use: (host: RunningHost) => Promise<void>): Promise<void> => {
    const host = await h.start({ runtime });
    try {
      await use(host);
    } finally {
      await host.terminate();
    }
  };

  test("thread-crash", () =>
    ownHost(async (host) => {
      await threadCrash(h, host);
      await crashPrinted(h, runtime);
    }));

  test("heap-full", () =>
    ownHost(async (host) => {
      await heapFull(h, host);
      await h.printed.take(abortPrinted, { count: 1 });
    }));

  test("mem-stress", () => ownHost((host) => memStress(h, host)));
  test("glib-stress", () => ownHost((host) => glibStress(h, host)));
});

describe.each(h.data.runtimes)("the host on the $name runtime", (runtime) => {
  test("fails to start when the runtime fails to instantiate", () => failedInstantiate(h, runtime));
  test("refuses a memory the runtime can't take", () => refusedMemory(h, runtime));
  test("reports a relay that fails as a crash", () => relayFailure(h, runtime));
  test("logs a top-up that doesn't finish in time, and tops up no more", () => topUpLimit(h, runtime));
});

describe.each(h.data.runtimes)("storage on the $name runtime", (runtime) => {
  // The engine's directory on the storage that outlives the host.
  describe("one host", () => {
    const engine = engineFor(h, "storage", runtime);
    let host: RunningHost;
    beforeAll(async () => {
      host = await storedHost(h, runtime, engine);
    });
    afterAll(() => host?.terminate());
    afterEach(() => noLateReplies(host.client));

    test("storage-roundtrip", () => storageRoundtrip(h, host, engine));
    test("promise-proxied-fsync", () =>
      promiseProxiedFsync(h, host, ["/tmp/fsync-memory.txt", `${engineDir(engine)}/fsync-${h.storageMount}.txt`]));
    test("storage-costs", () => storageCosts(h, host, engine));
  });

  // Each of these needs a host of its own.
  const ownHost = async (
    engine: ModuleManifest,
    use: (host: RunningHost, engine: ModuleManifest) => Promise<void>,
    options: Partial<HostOptions> = {},
  ): Promise<void> => {
    const host = await storedHost(h, runtime, engine, options);
    try {
      await use(host, engine);
      noLateReplies(host.client);
    } finally {
      await host.terminate();
    }
  };

  test("storage-fallback", () =>
    ownHost(
      engineFor(h, "storage-fallback", runtime),
      async (host, engine) => {
        await storageFallback(h, host, engine, h.data.constants.memory.minimum);
        await installedInMemory(h, host, engine);
        await promiseProxiedFsync(h, host, [`${engineDir(engine)}/fsync-memory-mount.txt`]);
      },
      { storage: { kind: "browser" }, test: h.withoutIndexedDB },
    ));
  // Node's Web Locks can grant an exclusive lock twice, so hosts sharing storage start one at a time.
  test("writer-lock", () => writerLock(h, runtime, engineFor(h, "writer-lock", runtime), false));
  test("a crash with the runtime intact seals the user data and lets go of every lock", () =>
    crashReleasesLocks(h, runtime));
  test("a trap lets go of every lock but a sealable backend's writer lock, until the Worker ends", () =>
    trapKeepsWriter(h, runtime));
  test("a failed start seals the user data and lets go of every lock", () => failedStartReleasesLocks(h, runtime));
});

// The installer's policy, on a host of its own with room for a large file.
describe.each(h.data.runtimes)("the installer on the $name runtime", (runtime) => {
  let host: RunningHost;
  beforeAll(async () => {
    const memory = 64 * 1024 * 1024;
    host = await h.start({ runtime, memory: { initial: memory, maximum: memory } });
  });
  afterAll(() => host?.terminate());

  test("whole, in pieces", () => installWhole(h, host));
  test("over a half-written tree", () => installOverPartial(h, host));
  test("refused archives", () => installRefused(h, host));
  test("malformed archives", () => installMalformed(h, host));
  test("its limit", () => installLimit(h, host));
  test("modes", () => installModes(h, host));
  test("symbolic links", () => installSymlinks(h, host));
  test("long names and link targets", () => installLongNames(h, host));
  test("links refused", () => installLinksRefused(h, host));
  test("never through a link", () => installThroughLinks(h, host));
  test("its directory", () => installTarget(h, host));
  test("a large file in its own size", () => installLargeFile(h, host));
  test("FS calls failing", () => fsFailures(h, host));
});

// Node's Web Locks can grant an exclusive lock twice, so install-concurrent runs only in browsers.
describe.each(h.data.runtimes)("engine data on the $name runtime", (runtime) => {
  test("install-fresh", () => installFresh(h, runtime));
  for (const memory of [false, true])
    test(`store-links-${memory ? "memory" : "stored"}`, () => storeLinks(h, runtime, memory));
  for (const encoding of ["identity", "br"] as const)
    for (const delta of [-1, 0, 1])
      test(`install-size-${encoding}-${delta}`, () => installSizeMismatch(h, runtime, encoding, delta));
  for (const fallback of [false, true]) {
    test(`install-brotli-${fallback}`, () => installBrotli(h, runtime, fallback));
    for (const kind of ["corrupt", "truncated"] as const)
      test(`install-${kind}-brotli-${fallback}`, () => installBrokenBrotli(h, runtime, kind, fallback));
  }
  test("install-skip", () => installSkip(h, runtime));
  test("install-interrupted", () => installInterrupted(h, runtime));
  test("install-interrupted-queued", () => installInterruptedQueued(h, runtime));
  test("install-interrupted-stray", () => installInterruptedStray(h, runtime));
  test("install-torn-marker", () => installTornMarker(h, runtime));
  test("rebuilt-distribution-while-running", () => rebuiltDistributionWhileRunning(h, runtime));
  test("upgrade-while-running", () => upgradeWhileRunning(h, runtime));
  test("interrupted-upgrade-then-old", () => interruptedUpgradeThenOld(h, runtime));
  test("stale-file", () => staleFile(h, runtime));
  test("failed-start-releases-locks", () => failedInstallReleasesLocks(h, runtime));
  test("data-read-only", () => dataReadOnly(h, runtime));
  test("a stray marking of its own version is installed over, and another version's collected", () =>
    strayMarking(h, runtime));
  test("a wait for the install lock outlives the lock limit while the installer's word keeps arriving", () =>
    waitOutlivesLimit(h, runtime));
  test("a wait for the install lock fails once the installer's word stops", () => waitFailsWithoutProgress(h, runtime));
});

// Node's Web Locks can grant an exclusive lock twice, so prepare-race runs only in browsers.
describe.each(h.data.runtimes)("an engine's own data on the $name runtime", (runtime) => {
  test("prepare-fresh", () => prepareFresh(h, runtime));
  test("prepare-skip", () => prepareSkip(h, runtime));
  test("prepare-concurrent", () => prepareConcurrent(h, runtime));
  test("prepare-shared", () => prepareShared(h, runtime));
  test("prepare-after-mount", () => prepareAfterMount(h, runtime));
  test("prepare-interrupted", () => prepareInterrupted(h, runtime));
  test("prepare-moved-unmarked", () => prepareMovedUnmarked(h, runtime));
  test("prepare-whole", () => prepareWhole(h, runtime));
  test("prepare-window-shut", () => prepareWindowShut(h, runtime));
  test("prepared-distribution", () => preparedDistribution(h, runtime));
  test("prepared-in-memory", async () => {
    const host = await h.start({
      runtime,
      engine: lazyEngineFor(h, "prepared-in-memory", runtime),
      storage: { kind: "browser" },
      test: h.withoutIndexedDB,
    });
    try {
      await preparedInMemory(h, host);
    } finally {
      await host.terminate();
    }
  });
});

// The Worker scripts exactly as the package ships them, loaded as they are
// on disk: the host and, beside it, its relay.
describe.each(h.data.runtimes)("the host as released on the $name runtime", (runtime) => {
  const releasedHost = async (use: (host: RunningHost) => Promise<void>): Promise<void> => {
    const host = await h.start({ runtime, released: true });
    try {
      await use(host);
    } finally {
      await host.terminate();
    }
  };
  test("protocol dispatch", () => releasedHost((host) => protocolRoundtrip(h, host)));
  test("relay-failure", () => relayFailure(h, runtime, true));
  test("ignores what HostInit.test asks", () => released(h, runtime));
});
