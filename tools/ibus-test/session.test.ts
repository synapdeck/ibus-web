// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { withNativeSession, type NativeEngineConfig, type NativeSession } from "./session.ts";
import type { Setting, Trace } from "./types.ts";

const execute = promisify(execFile);
const configPath = process.env["IBUS_TEST_NATIVE_CONFIG"];
const fixtureCommand = process.env["IBUS_TEST_FIXTURE_COMMAND"];
const directories: string[] = [];
const schema = "org.freedesktop.ibus.engine.hangul";
const initialSettings: Setting[] = [{ schema, key: "initial-input-mode", value: "'hangul'" }];

function artifacts() {
  const directory = mkdtempSync(join(tmpdir(), "ibus-session-test-"));
  directories.push(directory);
  return directory;
}

function nativeConfig(): NativeEngineConfig {
  return JSON.parse(readFileSync(configPath!, "utf8"));
}

function fixtureConfig(): NativeEngineConfig {
  return {
    ...nativeConfig(),
    engine: JSON.parse(fixtureCommand!),
    destination: "org.example.IBusTest",
    env: {
      ...nativeConfig().env,
      IBUS_TEST_SETTING_SCHEMA: schema,
      IBUS_TEST_SETTING_KEY: "hangul-keyboard",
    },
  };
}

function fixtureTrace(): Trace {
  return {
    version: 1,
    settings: [],
    steps: [
      { op: "create", context: "a", engine: "fixture" },
      { op: "call", context: "a", method: "ProcessKeyEvent", args: "(uint32 1, uint32 0, uint32 0)" },
      { op: "destroy", context: "a" },
    ],
  };
}

function expectCleaned(artifactDir: string) {
  const manifest = JSON.parse(readFileSync(join(artifactDir, "session.json"), "utf8")) as {
    resourceDir: string;
    processes: { pid: number }[];
  };
  expect(existsSync(manifest.resourceDir)).toBe(false);
  for (const { pid } of manifest.processes) {
    expect(() => process.kill(pid, 0)).toThrow();
    expect(() => process.kill(-pid, 0)).toThrow();
  }
}

async function setting(session: NativeSession, key: string) {
  const command = nativeConfig().gsettings;
  const result = await execute(command[0]!, [...command.slice(1), "get", schema, key], { env: session.env });
  return result.stdout.trim();
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(!configPath || !fixtureCommand)("private native sessions", () => {
  test("waits for the controlled engine and preserves the caller environment", async () => {
    const originalEnvironment = { ...process.env };
    const artifactDir = artifacts();
    const config = fixtureConfig();
    config.env = {
      ...config.env,
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/invalid-inherited-bus",
      IBUS_ADDRESS: "unix:path=/invalid-inherited-ibus",
      IBUS_ADDRESS_FILE: "/invalid-inherited-address-file",
      XDG_CONFIG_HOME: "/invalid-inherited-config",
      GSETTINGS_BACKEND: "dconf",
      DISPLAY: ":999",
      IBUS_USE_PORTAL: "1",
    };
    await withNativeSession(
      config,
      [],
      async (session) => {
        expect(session.env["XDG_CONFIG_HOME"]).toBe(join(session.resourceDir, "config"));
        expect(session.env["IBUS_ADDRESS_FILE"]).toBe(join(session.resourceDir, "ibus-address"));
        expect(session.env["GSETTINGS_BACKEND"]).toBe("keyfile");
        expect(session.env["IBUS_USE_PORTAL"]).toBeUndefined();
        expect(session.env["HOME"]).toBe(originalEnvironment["HOME"]);
        expect(session.env["DISPLAY"]).toBeUndefined();
        expect(session.env["WAYLAND_DISPLAY"]).toBeUndefined();
        const result = await session.run(fixtureTrace());
        expect(result.exitCode).toBe(0);
        expect(result.records.some((record) => record.kind === "event" && record.name === "CommitText")).toBe(true);
      },
      { artifactDir },
    );
    expect(process.env).toEqual(originalEnvironment);
    expectCleaned(artifactDir);
  });

  test("seeds real Hangul settings before launch and composes Hangul without a display", async () => {
    const artifactDir = artifacts();
    await withNativeSession(
      nativeConfig(),
      initialSettings,
      async (session) => {
        expect(await setting(session, "initial-input-mode")).toBe("'hangul'");
        const trace: Trace = {
          version: 1,
          settings: initialSettings,
          steps: [
            { op: "create", context: "a", engine: "hangul" },
            { op: "call", context: "a", method: "SetCapabilities", args: "(uint32 9,)" },
            { op: "call", context: "a", method: "FocusIn", args: "()" },
            { op: "call", context: "a", method: "Enable", args: "()" },
            { op: "call", context: "a", method: "ProcessKeyEvent", args: "(uint32 114, uint32 19, uint32 0)" },
            { op: "call", context: "a", method: "ProcessKeyEvent", args: "(uint32 107, uint32 37, uint32 0)" },
            { op: "call", context: "a", method: "ProcessKeyEvent", args: "(uint32 32, uint32 57, uint32 0)" },
            { op: "destroy", context: "a" },
          ],
        };
        const result = await session.run(trace);
        expect(result.exitCode, result.stderr).toBe(0);
        expect(
          result.records.some(
            (record) => record.kind === "event" && record.name === "CommitText" && record.payload.text.includes("가"),
          ),
        ).toBe(true);
      },
      { artifactDir },
    );
    expectCleaned(artifactDir);
  });

  test("isolates settings and engine contexts across simultaneous sessions", async () => {
    const firstArtifacts = artifacts();
    const secondArtifacts = artifacts();
    await withNativeSession(
      fixtureConfig(),
      [{ schema, key: "hangul-keyboard", value: "'2'" }],
      async (first) => {
        await withNativeSession(
          fixtureConfig(),
          [{ schema, key: "hangul-keyboard", value: "'3f'" }],
          async (second) => {
            expect(first.env["IBUS_ADDRESS"]).not.toBe(second.env["IBUS_ADDRESS"]);
            expect(first.env["DBUS_SESSION_BUS_ADDRESS"]).not.toBe(second.env["DBUS_SESSION_BUS_ADDRESS"]);
            expect(await setting(first, "hangul-keyboard")).toBe("'2'");
            expect(await setting(second, "hangul-keyboard")).toBe("'3f'");
            const snapshotTrace = fixtureTrace();
            snapshotTrace.steps.splice(1, 1, {
              op: "call",
              context: "a",
              method: "ProcessKeyEvent",
              args: "(uint32 8, uint32 0, uint32 0)",
            });
            const results = await Promise.all([first.run(snapshotTrace), second.run(snapshotTrace)]);
            expect(results.map((result) => result.exitCode)).toEqual([0, 0]);
            const committedSettings = results.map((result) =>
              result.records.filter((record) => record.kind === "event" && record.name === "CommitText"),
            );
            expect(committedSettings.map((records) => records.length)).toEqual([1, 1]);
            expect(committedSettings[0]![0]).toMatchObject({ payload: { text: expect.stringContaining("'2'") } });
            expect(committedSettings[1]![0]).toMatchObject({ payload: { text: expect.stringContaining("'3f'") } });
            // The private session buses also have independent D-Bus identities.
            const probe = nativeConfig().gdbus;
            const query = async (session: NativeSession) =>
              execute(
                probe[0]!,
                [
                  ...probe.slice(1),
                  "call",
                  "--address",
                  session.env["DBUS_SESSION_BUS_ADDRESS"]!,
                  "--dest",
                  "org.freedesktop.DBus",
                  "--object-path",
                  "/org/freedesktop/DBus",
                  "--method",
                  "org.freedesktop.DBus.GetId",
                ],
                { env: session.env },
              );
            expect((await query(first)).stdout).not.toBe((await query(second)).stdout);
          },
          { artifactDir: secondArtifacts },
        );
        expect((await first.run(fixtureTrace())).exitCode).toBe(0);
      },
      { artifactDir: firstArtifacts },
    );
    expectCleaned(firstArtifacts);
    expectCleaned(secondArtifacts);
  });

  test.each([
    [
      "failed engine",
      /engine.*spawn failure/,
      (config: NativeEngineConfig) => ({ ...config, engine: ["/does/not/exist"] }),
      [],
    ],
    [
      "failed config service",
      /config-service.*23/,
      (config: NativeEngineConfig) => ({
        ...config,
        configService: {
          command: [process.execPath, "-e", "process.exit(23)"],
          destination: "org.freedesktop.IBus.Config",
        },
      }),
      [],
    ],
    [
      "missing schema",
      /No such schema/,
      (config: NativeEngineConfig) => config,
      [{ schema: "org.example.Missing", key: "x", value: "true" }],
    ],
    [
      "invalid value",
      /settings exited/,
      (config: NativeEngineConfig) => config,
      [{ schema, key: "auto-reorder", value: "'invalid'" }],
    ],
    [
      "name deadline",
      /startup timeout/,
      (config: NativeEngineConfig) => ({ ...config, destination: "org.example.Missing", timeoutMs: 1500 }),
      [],
    ],
    [
      "missing readiness helper",
      /readiness.*spawn failure.*ENOENT/,
      (config: NativeEngineConfig) => ({ ...config, gdbus: ["/does/not/exist"], timeoutMs: 1500 }),
      [],
    ],
    [
      "invalid readiness helper",
      /startup timeout.*first readiness failure.*readiness exited \(23\)/,
      (config: NativeEngineConfig) => ({
        ...config,
        gdbus: [process.execPath, "-e", "process.exit(23)"],
        timeoutMs: 1500,
      }),
      [],
    ],
  ] as const)("cleans every owned process after %s", async (_name, expectedError, configure, settings) => {
    const artifactDir = artifacts();
    let used = false;
    await expect(
      withNativeSession(
        configure(fixtureConfig()),
        [...settings],
        async () => {
          used = true;
        },
        { artifactDir },
      ),
    ).rejects.toThrow(expectedError);
    expect(used).toBe(false);
    expectCleaned(artifactDir);
  });

  test("cancels startup while waiting for engine ownership", async () => {
    const artifactDir = artifacts();
    const controller = new AbortController();
    const config = { ...fixtureConfig(), destination: "org.example.NeverOwned" };
    const pending = withNativeSession(
      config,
      [],
      async () => {
        throw new Error("unready callback must not run");
      },
      { artifactDir, signal: controller.signal },
    );
    const timer = setTimeout(() => controller.abort(), 150);
    try {
      await expect(pending).rejects.toThrow(/aborted/);
      expectCleaned(artifactDir);
    } finally {
      clearTimeout(timer);
    }
  });

  test("runs the generic CLI with explicit config and retained artifacts", async () => {
    const artifactDir = artifacts();
    const configFile = join(artifactDir, "config.json");
    const traceFile = join(artifactDir, "input.json");
    writeFileSync(configFile, JSON.stringify(fixtureConfig()));
    writeFileSync(traceFile, JSON.stringify(fixtureTrace()));
    const cli = fileURLToPath(new URL("cli.ts", import.meta.url));
    const result = await execute(process.execPath, [
      cli,
      "--native-config",
      configFile,
      "--trace",
      traceFile,
      "--artifacts",
      artifactDir,
    ]);
    expect(result.stdout).toContain('"CommitText"');
    expect(result.stderr).toBe("");
    expectCleaned(artifactDir);
  });

  test("cleans a throwing callback", async () => {
    const artifactDir = artifacts();
    await expect(
      withNativeSession(
        fixtureConfig(),
        [],
        async () => {
          throw new Error("callback failed");
        },
        { artifactDir },
      ),
    ).rejects.toThrow("callback failed");
    expectCleaned(artifactDir);
  });

  test("cancels a running adapter and cleans separately grouped daemons", async () => {
    const artifactDir = artifacts();
    const controller = new AbortController();
    await expect(
      withNativeSession(
        fixtureConfig(),
        [],
        async (session) => {
          const trace = fixtureTrace();
          trace.steps.splice(1, 1, { op: "wait", context: "a", event: "Never", timeoutMs: 10000 });
          const result = session.run(trace);
          controller.abort();
          return result;
        },
        { artifactDir, signal: controller.signal },
      ),
    ).rejects.toThrow(/abort/i);
    expectCleaned(artifactDir);
  });

  test("retains services and resources through cooperative asynchronous callback cleanup", async () => {
    const artifactDir = artifacts();
    const controller = new AbortController();
    let markCallbackReady!: (session: NativeSession) => void;
    const callbackReady = new Promise<NativeSession>((resolve) => {
      markCallbackReady = resolve;
    });
    let markCleanupEntered!: () => void;
    const cleanupEntered = new Promise<void>((resolve) => {
      markCleanupEntered = resolve;
    });
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let callbackCompleted = false;
    let wrapperSettled = false;
    const pending = withNativeSession(
      fixtureConfig(),
      [],
      async (session) => {
        const aborted = new Promise<void>((resolve) => {
          session.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        markCallbackReady(session);
        try {
          await aborted;
          session.signal.throwIfAborted();
        } finally {
          markCleanupEntered();
          await cleanupGate;
          callbackCompleted = true;
          await Promise.reject(new Error("secondary callback cleanup failure"));
        }
      },
      { artifactDir, signal: controller.signal },
    );
    const observed = pending.then(
      () => {
        wrapperSettled = true;
        return undefined;
      },
      (error: unknown) => {
        wrapperSettled = true;
        return error;
      },
    );
    try {
      const session = await callbackReady;
      controller.abort();
      await cleanupEntered;
      expect(session.signal.aborted).toBe(true);
      expect(callbackCompleted).toBe(false);

      // A native round trip checks that the owned service remains usable while
      // finally is gated. No idle period stands in for callback completion.
      const probe = nativeConfig().gdbus;
      await execute(
        probe[0]!,
        [
          ...probe.slice(1),
          "call",
          "--address",
          session.env["DBUS_SESSION_BUS_ADDRESS"]!,
          "--dest",
          "org.freedesktop.DBus",
          "--object-path",
          "/org/freedesktop/DBus",
          "--method",
          "org.freedesktop.DBus.ListNames",
        ],
        { env: session.env, timeout: 2000 },
      );
      expect(existsSync(session.resourceDir)).toBe(true);
      expect(await setting(session, "hangul-keyboard")).toBe("'2'");
      expect(wrapperSettled).toBe(false);
    } finally {
      releaseCleanup();
      await observed;
    }
    expect(callbackCompleted).toBe(true);
    expect(await observed).toMatchObject({ message: "native session aborted" });
    expectCleaned(artifactDir);
  });

  test("aborts use when an owned engine dies", async () => {
    const artifactDir = artifacts();
    await expect(
      withNativeSession(
        fixtureConfig(),
        [],
        async (session) => {
          const trace = fixtureTrace();
          trace.steps.splice(1, 1, {
            op: "call",
            context: "a",
            method: "ProcessKeyEvent",
            args: "(uint32 3, uint32 0, uint32 0)",
          });
          await session.run(trace);
          session.signal.throwIfAborted();
          await new Promise((resolve) => session.signal.addEventListener("abort", resolve, { once: true }));
        },
        { artifactDir },
      ),
    ).rejects.toThrow(/engine.*23/);
    expectCleaned(artifactDir);
  });
});
