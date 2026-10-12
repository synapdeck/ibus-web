// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The scenarios of an engine's own data: store paths an engine names, which
// a host installs only when the page prepares that engine, each under an
// install lock and with a marker of its own. Each scenario has an engine,
// and so storage and locks, of its own.

import { expect } from "vitest";
import type { ModuleManifest } from "@ibus-web/protocol";
import type { PathInstallReport } from "../../src/shared/messages.ts";
import { engineDataDatabase, enginePathInstallLock, engineStagingDir } from "../../src/shared/naming.ts";
import type { Client } from "./client.ts";
import type { Harness, RunningHost, RuntimeBuild } from "./harness.ts";
import { counts, expectFreed, installOf, terminatedHostMayClose, waitFor, withHosts } from "./install.ts";
import { call32, errno, opsOf, round } from "./scenarios.ts";
import { replyFile } from "./storage.ts";
import type { Message } from "./testing.ts";

const encoder = new TextEncoder();

// Where the lazy test archives' trees land.
export const LAZY_PATH = "/nix/store/11111111111111111111111111111111-test-lazy";
const LAZY2_PATH = "/nix/store/22222222222222222222222222222222-test-lazy2";

// The engines that name them as their own data: "lazy" and "shared" the
// first, "lazy2" the second.
const LAZY_ENGINE = "lazy";
const LAZY2_ENGINE = "lazy2";
const SHARED_ENGINE = "shared";

// An engine of its own for a scenario on a runtime, whose base data is the
// test engine's own, its schemas, and whose other engines name the lazy
// archives as their own data. The archives' version is the engine's.
export const lazyEngineFor = (h: Harness, scenario: string, runtime: RuntimeBuild): ModuleManifest => {
  const { empty } = h.data.engines;
  const { lazy, lazy2 } = h.data.archives;
  const descriptor = empty.engines[0]!;
  return {
    ...empty,
    name: `${scenario}-${runtime.name}-${Math.random().toString(36).slice(2, 8)}`,
    memory: h.data.constants.memory.minimum,
    version: lazy.version,
    data: [
      ...empty.data,
      { storePath: LAZY_PATH, url: lazy.url, size: lazy.size, encoding: "identity" },
      { storePath: LAZY2_PATH, url: lazy2.url, size: lazy2.size, encoding: "identity" },
    ],
    engines: [
      ...empty.engines,
      { ...descriptor, name: LAZY_ENGINE, data: [LAZY_PATH] },
      { ...descriptor, name: LAZY2_ENGINE, data: [LAZY2_PATH] },
      { ...descriptor, name: SHARED_ENGINE, data: [LAZY_PATH] },
    ],
  };
};

const pathInstalls = (messages: readonly Message[], from = 0, engine = LAZY_ENGINE): PathInstallReport[] =>
  messages.slice(from).flatMap((message) => {
    if (message.type !== "path-install" || message.engine !== engine) return [];
    const { type: _, ...report } = message;
    return [report];
  });

const progressOf = (messages: readonly Message[], from = 0, engine = LAZY_ENGINE): { bytes: number; total: number }[] =>
  messages
    .slice(from)
    .flatMap((message) =>
      message.type === "prepare-progress" && message.engine === engine
        ? [{ bytes: message.bytes, total: message.total }]
        : [],
    );

// The tree under path as the host sees it, listed by list-tree, or the
// error that listing it failed with. A listing taken while the host
// installs lets the page go at once, since in Firefox a response body the
// host fetches waits while the page spins.
const listed = async (h: Harness, client: Client, path: string, budgetMs?: number): Promise<string | number> => {
  const reply = replyFile(
    await client.call(opsOf(h).listTree, encoder.encode(path), budgetMs === undefined ? {} : { budgetMs }),
  );
  return reply.text ?? reply.status;
};

// Checks what the host said of preparing the engine since from: its one
// store path found in state, and progress from 0 to the path's size when it
// had to be installed.
const expectPrepared = (
  h: Harness,
  host: RunningHost,
  from: number,
  engine: string,
  storePath: string,
  state: PathInstallReport["state"],
): PathInstallReport => {
  const { files, bytes } = counts(h.data.archives.lazy);
  const reports = pathInstalls(host.messages, from, engine);
  expect(reports, `${engine}'s path reports`).toMatchObject([{ engine, storePath, state, files, bytes }]);
  const progress = progressOf(host.messages, from, engine);
  if (state === "present") expect(progress, `${engine}'s progress for data already there`).toEqual([]);
  else {
    expect(progress[0], `${engine}'s first progress`).toEqual({ bytes: 0, total: h.data.archives.lazy.size });
    expect(progress.at(-1), `${engine}'s last progress`).toEqual({ bytes, total: h.data.archives.lazy.size });
  }
  return reports[0]!;
};

// Prepares the lazy engine and checks the host's answer: no error, and the
// lazy path found in state.
const prepareLazy = async (
  h: Harness,
  host: RunningHost,
  state: PathInstallReport["state"],
): Promise<PathInstallReport> => {
  const from = host.messages.length;
  const prepared = await host.prepare(LAZY_ENGINE);
  expect(prepared, "the prepare's answer").toEqual({ type: "prepared", engine: LAZY_ENGINE });
  return expectPrepared(h, host, from, LAZY_ENGINE, LAZY_PATH, state);
};

// Whether two installs held their locks at overlapping times.
const overlapped = (a: PathInstallReport, b: PathInstallReport): boolean =>
  a.lockedAt < b.releasedAt && b.lockedAt < a.releasedAt;

const expectLazyTree = async (h: Harness, client: Client, what = "the lazy tree"): Promise<void> => {
  expect(await listed(h, client, LAZY_PATH), what).toBe(h.data.archives.lazy.listing);
};

// A host installs at start the data no engine names, not the lazy path;
// preparing the engine that names it installs it, posting progress, and
// preparing it again finds its marker. An engine with no data of its own,
// and one the module doesn't have, are answered at once.
export const prepareFresh = (h: Harness, runtime: RuntimeBuild): Promise<void> =>
  withHosts(h, runtime, async (launch) => {
    const engine = lazyEngineFor(h, "prepare-fresh", runtime);
    const host = await launch(engine).ready;
    expect(installOf(host.messages), "the install report").toMatchObject({
      state: "installed",
      files: h.data.schemaFiles,
      bytes: h.data.engines.empty.data.reduce((sum, entry) => sum + entry.size, 0),
    });
    expect(await listed(h, host.client, LAZY_PATH), "the lazy path before").toBe(-errno(h, "ENOENT"));
    const installed = await prepareLazy(h, host, "installed");
    h.record("prepare-fresh", { lockWaitMs: round(installed.lockWaitMs, 1), installMs: round(installed.installMs, 1) });
    await expectLazyTree(h, host.client);
    expect((await prepareLazy(h, host, "present")).lockedAt, "a marker found without the lock").toBe(0);
    expect(await host.prepare(engine.engines[0]!.name), "an engine with no data of its own").toEqual({
      type: "prepared",
      engine: engine.engines[0]!.name,
    });
    expect((await host.prepare("missing")).error, "an engine the module lacks").toBe(
      `module ${engine.name} has no engine missing`,
    );
  });

// A host started after another installed the lazy path finds its marker and
// installs nothing.
export const prepareSkip = (h: Harness, runtime: RuntimeBuild): Promise<void> =>
  withHosts(h, runtime, async (launch) => {
    const engine = lazyEngineFor(h, "prepare-skip", runtime);
    const first = await launch(engine).ready;
    await prepareLazy(h, first, "installed");
    await first.terminate();
    const second = await launch(engine).ready;
    expect(installOf(second.messages)?.state, "the base data").toBe("present");
    await prepareLazy(h, second, "present");
    await expectLazyTree(h, second.client);
  });

// Of two hosts preparing the engine at once, one installs the lazy path and
// the other waits on the path's install lock, then finds the marker; both
// read the tree. Browsers only: Node's Web Locks can grant one exclusive
// lock twice.
export const prepareRace = (h: Harness, runtime: RuntimeBuild): Promise<void> =>
  withHosts(h, runtime, async (launch) => {
    const engine = lazyEngineFor(h, "prepare-race", runtime);
    const first = await launch(engine).ready;
    const second = await launch(engine).ready;
    const hosts = [first, second];
    const from = hosts.map(({ messages }) => messages.length);
    const answers = await Promise.all(hosts.map((host) => host.prepare(LAZY_ENGINE)));
    for (const answer of answers) expect(answer.error, "a prepare's error").toBeUndefined();
    const reports = hosts.map(({ messages }, i) => pathInstalls(messages, from[i])[0]!);
    const states = reports.map(({ state }) => state);
    expect(states.toSorted(), "the hosts' path states").toEqual(["installed", "present"]);
    const installed = reports[states.indexOf("installed")]!;
    const present = reports[states.indexOf("present")]!;
    h.record("prepare-race", { lockTakenAfterReleaseMs: present.lockedAt - installed.releasedAt });
    expect(present.lockedAt, "the second took the lock").toBeGreaterThanOrEqual(installed.releasedAt);
    for (const host of hosts) await expectLazyTree(h, host.client);
  });

// Two engines prepared at once whose data are different store paths install
// at the same time, each under its own lock, and the backend's window opens
// once as the first extraction starts and shuts once after the last ends.
export const prepareConcurrent = (h: Harness, runtime: RuntimeBuild): Promise<void> =>
  withHosts(h, runtime, async (launch) => {
    const engine = lazyEngineFor(h, "prepare-concurrent", runtime);
    const host = await launch(engine, { test: { pieceDelayMs: 20 } }).ready;
    const from = host.messages.length;
    const answers = await Promise.all([host.prepare(LAZY_ENGINE), host.prepare(LAZY2_ENGINE)]);
    for (const answer of answers) expect(answer.error, "a prepare's error").toBeUndefined();
    const first = expectPrepared(h, host, from, LAZY_ENGINE, LAZY_PATH, "installed");
    const second = expectPrepared(h, host, from, LAZY2_ENGINE, LAZY2_PATH, "installed");
    h.record("prepare-concurrent", {
      first: [first.lockedAt, first.releasedAt],
      second: [second.lockedAt, second.releasedAt],
    });
    expect(overlapped(first, second), "the two installs overlapped").toBe(true);
    const windows = host.messages.slice(from).flatMap((message) => (message.type === "window" ? [message] : []));
    expect(
      windows.map(({ open }) => open),
      "the window opened once and shut once",
    ).toEqual([true, false]);
    expect(windows[1]!.at, "the window shut after both started").toBeGreaterThanOrEqual(
      Math.max(first.lockedAt, second.lockedAt),
    );
    await expectLazyTree(h, host.client);
    expect(await listed(h, host.client, LAZY2_PATH), "the second tree").toBe(h.data.archives.lazy2.listing);
  });

// Two engines prepared at once that share a store path wait on one install
// of it: its archive is fetched once, and each engine's progress runs to the
// path's size.
export const prepareShared = (h: Harness, runtime: RuntimeBuild): Promise<void> =>
  withHosts(h, runtime, async (launch) => {
    const engine = lazyEngineFor(h, "prepare-shared", runtime);
    const host = await launch(engine, { test: { pieceDelayMs: 20 } }).ready;
    const from = host.messages.length;
    const answers = await Promise.all([host.prepare(LAZY_ENGINE), host.prepare(SHARED_ENGINE)]);
    for (const answer of answers) expect(answer.error, "a prepare's error").toBeUndefined();
    expectPrepared(h, host, from, LAZY_ENGINE, LAZY_PATH, "installed");
    expectPrepared(h, host, from, SHARED_ENGINE, LAZY_PATH, "installed");
    expect(
      host.messages
        .slice(from)
        .filter((message) => message.type === "fetching" && message.url === h.data.archives.lazy.url),
      "fetches of the shared path's archive",
    ).toHaveLength(1);
    await expectLazyTree(h, host.client);
  });

// A host that mounted the version before another host installed the lazy
// path, and looked for one of its files and found nothing, finds it once
// the other host has installed it, without preparing the engine itself;
// preparing it then finds the marker.
export const prepareAfterMount = (h: Harness, runtime: RuntimeBuild): Promise<void> =>
  withHosts(h, runtime, async (launch) => {
    const engine = lazyEngineFor(h, "prepare-after-mount", runtime);
    const file = h.data.archives.lazy.listing
      .split("\n")
      .find((line) => /\tf /.test(line))!
      .split("\t")[0]!;
    const path = `${LAZY_PATH}/${file}`;
    const read = async (client: Client) => replyFile(await client.call(opsOf(h).readFile, encoder.encode(path))).status;
    const mounted = await launch(engine).ready;
    expect(await read(mounted.client), "the file before it is installed").toBe(-errno(h, "ENOENT"));
    expect(await listed(h, mounted.client, LAZY_PATH), "the lazy path before").toBe(-errno(h, "ENOENT"));
    const installer = await launch(engine).ready;
    await prepareLazy(h, installer, "installed");
    expect(await read(mounted.client), "the file once another host installed it").toBeGreaterThanOrEqual(0);
    await expectLazyTree(h, mounted.client, "the lazy tree once another host installed it");
    await prepareLazy(h, mounted, "present");
  });

// A host whose Worker is terminated halfway through installing the lazy
// path leaves no marker and no store path, only its staging tree: the next
// host to prepare the engine removes that tree, extracts the archive again
// and moves it into place, and the tree is the archive's, its counts whole.
export const prepareInterrupted = (h: Harness, runtime: RuntimeBuild): Promise<void> =>
  withHosts(h, runtime, async (launch) => {
    const engine = lazyEngineFor(h, "prepare-interrupted", runtime);
    const staging = engineStagingDir(engine, { storePath: LAZY_PATH });
    const { lazy } = h.data.archives;
    const launched = launch(engine, { test: { stallAt: Math.floor(lazy.size / 2) } });
    const first = await launched.ready;
    void first.prepare(LAZY_ENGINE).catch(() => {});
    const { bytes } = await waitFor(
      h,
      launched,
      (message): message is { type: "stalled"; bytes: number } => message.type === "stalled",
      "the install stalling",
    );
    expect(bytes, "archive bytes fed before the stall").toBeLessThan(lazy.size);
    await first.terminate();
    await expectFreed(h, enginePathInstallLock(engine, LAZY_PATH));
    const next = await launch(engine).ready;
    expect(installOf(next.messages)?.state, "the base data").toBe("present");
    expect(await listed(h, next.client, LAZY_PATH), "the store path the first left").toBe(-errno(h, "ENOENT"));
    expect(typeof (await listed(h, next.client, staging)), "the staging tree the first left").toBe("string");
    const from = next.messages.length;
    await prepareLazy(h, next, "installed");
    expect(
      next.messages.slice(from).filter((message) => message.type === "swept"),
      "the staging tree removed",
    ).toEqual([{ type: "swept", path: staging }]);
    await expectLazyTree(h, next.client);
    expect(await listed(h, next.client, staging), "the staging tree after").toBe(-errno(h, "ENOENT"));
    await terminatedHostMayClose(h, engineDataDatabase(engine));
  });

// A host whose Worker is terminated after it moved the lazy path's tree
// into place but before it wrote the path's marker leaves the path whole:
// the next host to prepare the engine marks it without fetching the archive
// again, counting what is there.
export const prepareMovedUnmarked = (h: Harness, runtime: RuntimeBuild): Promise<void> =>
  withHosts(h, runtime, async (launch) => {
    const engine = lazyEngineFor(h, "prepare-moved-unmarked", runtime);
    const launched = launch(engine, { test: { stallBeforeMark: true } });
    const first = await launched.ready;
    void first.prepare(LAZY_ENGINE).catch(() => {});
    await waitFor(
      h,
      launched,
      (message): message is { type: "stalled-marking"; storePath: string } =>
        message.type === "stalled-marking" && message.storePath === LAZY_PATH,
      "the install stopping before its marker",
    );
    await first.terminate();
    await expectFreed(h, enginePathInstallLock(engine, LAZY_PATH));
    const next = await launch(engine).ready;
    await expectLazyTree(h, next.client, "the tree the first moved into place");
    const from = next.messages.length;
    const prepared = await next.prepare(LAZY_ENGINE);
    expect(prepared, "the prepare's answer").toEqual({ type: "prepared", engine: LAZY_ENGINE });
    const { files, bytes } = counts(h.data.archives.lazy);
    expect(pathInstalls(next.messages, from), "the path's report").toMatchObject([
      { storePath: LAZY_PATH, state: "installed", files, bytes },
    ]);
    expect(
      next.messages.slice(from).filter((message) => message.type === "fetching" || message.type === "swept"),
      "fetches and sweeps",
    ).toEqual([]);
    await prepareLazy(h, next, "present");
    await expectLazyTree(h, next.client);
    await terminatedHostMayClose(h, engineDataDatabase(engine));
  });

// A reader in the installing host, polling the lazy path while the install
// runs, finds no store path until it finds the whole tree: never a tree the
// installer is still writing.
export const prepareWhole = (h: Harness, runtime: RuntimeBuild): Promise<void> =>
  withHosts(h, runtime, async (launch) => {
    const engine = lazyEngineFor(h, "prepare-whole", runtime);
    const { lazy } = h.data.archives;
    const host = await launch(engine, { test: { pieceDelayMs: 20 } }).ready;
    const from = host.messages.length;
    let answer: Awaited<ReturnType<RunningHost["prepare"]>> | undefined;
    const preparing = host.prepare(LAZY_ENGINE).then((prepared) => (answer = prepared));
    // Whether the install has written some of the path's data but not all.
    const midway = (): boolean =>
      progressOf(host.messages, from).some(({ bytes, total }) => bytes > 0 && bytes < total);
    let missedMidway = 0;
    let found: string | number = -errno(h, "ENOENT");
    while (answer === undefined) {
      const during = midway();
      found = await listed(h, host.client, LAZY_PATH, 1);
      if (found !== -errno(h, "ENOENT")) break;
      if (during && answer === undefined) missedMidway++;
      await h.sleep(2);
    }
    await preparing;
    h.record("prepare-whole", { missedMidway });
    expect(answer, "the prepare's answer").toEqual({ type: "prepared", engine: LAZY_ENGINE });
    if (found !== -errno(h, "ENOENT")) expect(found, "the tree as first found").toBe(lazy.listing);
    expect(missedMidway, "listings that found no path while the install was midway").toBeGreaterThan(0);
    await expectLazyTree(h, host.client);
    expect(await listed(h, host.client, engineStagingDir(engine, { storePath: LAZY_PATH })), "the staging tree").toBe(
      -errno(h, "ENOENT"),
    );
  });

// The backend's window is open only while a host installs: a file written
// into the store once the lazy path is installed, or once an install of it
// has failed, fails with EROFS, and the tree stays the archive's. The Node
// backend has no read-only mode, so under Node the writes are recorded,
// not judged.
export const prepareWindowShut = (h: Harness, runtime: RuntimeBuild): Promise<void> =>
  withHosts(h, runtime, async (launch) => {
    const engine = lazyEngineFor(h, "prepare-window-shut", runtime);
    const broken: ModuleManifest = {
      ...engine,
      data: engine.data.map((entry) =>
        entry.storePath === LAZY_PATH ? { ...entry, url: h.data.archives.missing } : entry,
      ),
    };
    const write = (client: Client): Promise<number> =>
      call32(client, opsOf(h).writeFile, encoder.encode("/nix/store/written.txt\0x"));
    const failing = await launch(broken).ready;
    const failed = await failing.prepare(LAZY_ENGINE);
    expect(failed.error, "the failed prepare's error").toBe(`fetch ${h.data.archives.missing}: 404`);
    await expectFreed(h, enginePathInstallLock(engine, LAZY_PATH));
    const afterFailure = await write(failing.client);
    const installing = await launch(engine).ready;
    await prepareLazy(h, installing, "installed");
    const afterInstall = await write(installing.client);
    h.record("prepare-window-shut", { afterFailure, afterInstall });
    if (h.storageMount !== "indexeddb") return;
    expect(afterFailure, "a write after a failed install").toBe(-errno(h, "EROFS"));
    expect(afterInstall, "a write after an install").toBe(-errno(h, "EROFS"));
    await expectLazyTree(h, installing.client);
  });

// Without IndexedDB the data lives in the runtime's memory, which can't
// grow, so the host installs every store path at start, both lazy archives
// among them, and a prepare finds nothing to do.
export const preparedInMemory = async (h: Harness, host: RunningHost): Promise<void> => {
  const { files, bytes } = counts(h.data.archives.lazy);
  expect(installOf(host.messages), "the install report").toMatchObject({
    state: "installed",
    files: 2 * files + h.data.schemaFiles,
    bytes: 2 * bytes + h.data.engines.empty.data.reduce((sum, entry) => sum + entry.size, 0),
    lockWaitMs: 0,
  });
  await expectLazyTree(h, host.client);
  const from = host.messages.length;
  expect(await host.prepare(LAZY_ENGINE), "the prepare").toEqual({ type: "prepared", engine: LAZY_ENGINE });
  expect(pathInstalls(host.messages, from), "path reports").toEqual([]);
};

// The echo engine's distribution as mkEngineManifest builds it, whose
// second engine names as its own data the store path the echo data's links
// lead into: a link into it dangles until that engine is prepared.
export const preparedDistribution = (h: Harness, runtime: RuntimeBuild): Promise<void> =>
  withHosts(h, runtime, async (launch) => {
    const engine = { ...h.data.engines.lazy, name: `prepared-distribution-${runtime.name}-${Math.random()}` };
    const lazy = engine.engines.find(({ data }) => data !== undefined);
    expect(lazy?.data, "the engine with data of its own").toHaveLength(1);
    const dir = h.data.echoData.slice(0, h.data.echoData.lastIndexOf("/"));
    const host = await launch(engine).ready;
    const read = async (path: string) => replyFile(await host.client.call(opsOf(h).readFile, encoder.encode(path)));
    expect((await read(`${dir}/data.txt`)).text, "the base data").toBe("echo store data\n");
    expect((await read(`${dir}/absolute.txt`)).status, "a link into the engine's data, before").toBe(
      -errno(h, "ENOENT"),
    );
    expect((await host.prepare(lazy!.name)).error, "the prepare's error").toBeUndefined();
    expect((await read(`${dir}/absolute.txt`)).text, "a link into the engine's data, after").toBe("echo link target\n");
  });
