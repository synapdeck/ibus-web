// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Scenarios for installing an engine's data at start, which take several
// hosts sharing one engine's storage, as tabs of one origin, or Node hosts
// given one directory, do. Each scenario has an engine, and so storage and
// an install lock, of its own, named after it.

import {
  engineDataDir,
  engineMarker,
  withData,
  type EngineManifest,
  type HostMessage,
  type InstallReport,
  type TestData,
} from "./control.ts";
import {
  replyFile,
  type Client,
  type Env,
  type Outcome,
  type Result,
} from "./scenarios.ts";

export interface InstallHost {
  // The host's messages but "ready", as they arrive.
  messages: readonly HostMessage[];
  // Settles once the host is ready, or rejects with why it didn't start.
  ready: Promise<Client>;
  // Settles once the host's Worker is gone, and its locks with it.
  terminate(): Promise<void>;
}

export interface InstallHarness {
  env: Env;
  // The test archive, and the URL hosts fetch it from.
  data: TestData;
  dataUrl: string;
  // Starts a host for engine on the storage every host for that engine
  // shares.
  start(
    engine: EngineManifest,
    options?: { installStallAt?: number },
  ): InstallHost;
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

const summary = (report: InstallReport | undefined): string =>
  report === undefined
    ? "no install report"
    : `${report.state}: ${report.bytes} bytes in ${round(report.installMs)} ms, ` +
      `after waiting ${round(report.lockWaitMs)} ms for the lock`;

// Whether the engine's installed tree is the archive's, and its marker
// holds the archive's version.
const inspect = async (
  harness: InstallHarness,
  engine: EngineManifest,
  client: Client,
): Promise<{ pass: boolean; tree: string; marker: string }> => {
  const { env, data } = harness;
  const dir = engineDataDir(engine, engine.data[0]!);
  const tree = replyFile(
    await client.call(env.ops.listTree, env.utf8(dir)),
    env,
  );
  const marker = replyFile(
    await client.call(env.ops.readFile, env.utf8(engineMarker(engine))),
    env,
  );
  return {
    pass: tree.text === data.listing && marker.text === data.version,
    tree:
      tree.text === data.listing
        ? "the archive's"
        : (tree.text ?? `error ${tree.status}`),
    marker: marker.text ?? `error ${marker.status}`,
  };
};

const installFresh: InstallScenario = {
  name: "install-fresh",
  criterion:
    "a host starting on storage that holds nothing installs the engine's data before it is " +
    "ready: the tree is the archive's, and the marker holds its version",
  async run(harness, engine, started): Promise<Outcome> {
    const host = harness.start(engine);
    started.push(host);
    const client = await ready(harness, host);
    const report = installOf(host);
    const seen = await inspect(harness, engine, client);
    return {
      pass: report?.state === "installed" && seen.pass,
      measurements: {
        install: summary(report),
        tree: seen.tree,
        marker: seen.marker,
      },
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
        marker: seen.marker,
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
        markers: seen.map(({ marker }) => marker),
      },
    };
  },
};

const STALL_LIMIT_MS = 30_000;

const installInterrupted: InstallScenario = {
  name: "install-interrupted",
  criterion:
    "a host whose Worker is terminated halfway through installing leaves no marker: the next " +
    "host to start installs again, over what the first left, and the tree is the archive's, " +
    "whole and correct",
  async run(harness, engine, started): Promise<Outcome> {
    const { env, data } = harness;
    const stallAt = Math.floor(data.size / 2);
    const first = harness.start(engine, { installStallAt: stallAt });
    started.push(first);
    const failed = first.ready.then(
      () => "ready, without stalling",
      (error: unknown) => String(error),
    );
    const deadline = env.now() + STALL_LIMIT_MS;
    let stalled: InstallReport | undefined;
    let early: string | undefined;
    void failed.then((why) => {
      early = why;
    });
    while (
      stalled === undefined &&
      early === undefined &&
      env.now() < deadline
    ) {
      stalled = first.messages.find(
        (message): message is { type: "install" } & InstallReport =>
          message.type === "install" && message.state === "stalled",
      );
      if (stalled === undefined) await env.sleep(10);
    }
    if (stalled === undefined)
      return {
        pass: false,
        measurements: {
          stalled: early ?? `no stall in ${STALL_LIMIT_MS} ms`,
        },
      };
    await first.terminate();
    const second = harness.start(engine);
    started.push(second);
    const client = await ready(harness, second);
    const report = installOf(second);
    const seen = await inspect(harness, engine, client);
    return {
      pass:
        stalled.bytes === stallAt && report?.state === "installed" && seen.pass,
      measurements: {
        stalled: `after ${stalled.bytes} bytes`,
        next: summary(report),
        tree: seen.tree,
        marker: seen.marker,
      },
    };
  },
};

export const installScenarios: readonly InstallScenario[] = [
  installFresh,
  installSkip,
  installConcurrent,
  installInterrupted,
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
