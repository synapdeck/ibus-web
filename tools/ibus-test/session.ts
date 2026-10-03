// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runAdapter } from "./process.ts";
import type { RunResult, Setting, Trace } from "./types.ts";

export type NativeEngineConfig = {
  sessionBus: string[];
  daemon: string[];
  daemonDestination: string;
  configService?: { command: string[]; destination: string };
  engine: string[];
  adapter: string[];
  gdbus: string[];
  gsettings: string[];
  destination: string;
  factory: string;
  env: Record<string, string>;
  timeoutMs: number;
};

export type NativeSession = {
  env: NodeJS.ProcessEnv;
  adapterCommand: string[];
  artifactDir: string;
  resourceDir: string;
  signal: AbortSignal;
  run: (trace: Trace) => Promise<RunResult>;
};

export type NativeSessionOptions = { artifactDir?: string; signal?: AbortSignal };

type OwnedProcess = {
  name: string;
  child: ChildProcess;
  exited: Promise<void>;
  stderrPath: string;
  command: readonly string[];
  groupClosed: boolean;
  error?: Error;
};

function validateCommand(command: unknown, name: string): asserts command is string[] {
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string" || !part)) {
    throw new TypeError(`${name} must be a nonempty argv array`);
  }
}

export function validateNativeConfig(value: unknown): NativeEngineConfig {
  if (value === null || typeof value !== "object") throw new TypeError("native config must be an object");
  const config = value as NativeEngineConfig;
  for (const name of ["sessionBus", "daemon", "engine", "adapter", "gdbus", "gsettings"] as const) {
    validateCommand(config[name], name);
  }
  if (config.configService) {
    validateCommand(config.configService.command, "configService.command");
    if (typeof config.configService.destination !== "string" || !config.configService.destination) {
      throw new TypeError("configService.destination is required");
    }
  }
  if (typeof config.daemonDestination !== "string" || !config.daemonDestination) {
    throw new TypeError("daemonDestination is required");
  }
  if (typeof config.destination !== "string" || !config.destination) throw new TypeError("destination is required");
  if (typeof config.factory !== "string" || !config.factory.startsWith("/"))
    throw new TypeError("factory must be an object path");
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0 || config.timeoutMs > 2 ** 31 - 1) {
    throw new TypeError("timeoutMs must be a positive 32-bit integer");
  }
  if (
    !config.env ||
    typeof config.env !== "object" ||
    Array.isArray(config.env) ||
    Object.values(config.env).some((value) => typeof value !== "string")
  ) {
    throw new TypeError("env must contain string values");
  }
  if ("HOME" in config.env) throw new TypeError("native config must not override HOME");
  return config;
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/** Own all service groups until use finishes; callbacks should honor session.signal. */
export async function withNativeSession<T>(
  input: NativeEngineConfig,
  settings: Setting[],
  use: (session: NativeSession) => Promise<T>,
  options: NativeSessionOptions = {},
): Promise<T> {
  const config = validateNativeConfig(input);
  options.signal?.throwIfAborted();
  const artifactDir = options.artifactDir ?? mkdtempSync(join(tmpdir(), "ibus-artifacts-"));
  mkdirSync(artifactDir, { recursive: true });
  const resourceDir = mkdtempSync(join(tmpdir(), "ibus-session-"));
  const processes: OwnedProcess[] = [];
  const adapters = new Set<Promise<RunResult>>();
  const controller = new AbortController();
  let closing = false;
  let callback: Promise<T> | undefined;
  let commandNumber = 0;
  let runNumber = 0;
  const onAbort = () => controller.abort(new Error("native session aborted", { cause: options.signal?.reason }));
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const interrupted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
  });
  // Failure can arrive between awaited operations. Keep the rejection observed.
  void interrupted.catch(() => {});
  const startupDeadline = setTimeout(
    () => controller.abort(new Error("native session startup timeout")),
    config.timeoutMs,
  );
  const env: NodeJS.ProcessEnv = { ...process.env, ...config.env };
  const sessionAddress = `unix:path=${join(resourceDir, "session-bus")}`;
  const ibusAddress = `unix:path=${join(resourceDir, "ibus-bus")}`;

  function manifest() {
    writeFileSync(
      join(artifactDir, "session.json"),
      `${JSON.stringify(
        {
          config,
          resourceDir,
          sessionAddress,
          ibusAddress,
          processes: processes.map(({ name, child, command, error }) => ({
            name,
            command,
            error: error?.message,
            pid: child.pid,
            exitCode: child.exitCode,
            signal: child.signalCode,
          })),
        },
        null,
        2,
      )}\n`,
    );
  }

  function processError(owned: OwnedProcess) {
    const diagnostics = readFileSync(owned.stderrPath, "utf8").slice(-8192);
    return new Error(
      `${owned.name} exited (${owned.error ? "spawn failure" : (owned.child.exitCode ?? owned.child.signalCode)}): ${owned.error?.message ?? ""}${diagnostics}`,
      { cause: owned.error },
    );
  }

  function launch(name: string, command: readonly string[], service: boolean): OwnedProcess {
    controller.signal.throwIfAborted();
    const prefix = `${commandNumber++}-${name}`;
    const stdoutPath = join(artifactDir, `${prefix}.stdout.txt`);
    const stderrPath = join(artifactDir, `${prefix}.stderr.txt`);
    const stdout = openSync(stdoutPath, "w");
    const stderr = openSync(stderrPath, "w");
    let child: ChildProcess;
    try {
      child = spawn(command[0]!, command.slice(1), {
        env,
        detached: true,
        shell: false,
        stdio: ["ignore", stdout, stderr],
      });
    } finally {
      closeSync(stdout);
      closeSync(stderr);
    }
    const owned: OwnedProcess = {
      name,
      child,
      command,
      stderrPath,
      groupClosed: false,
      exited: Promise.resolve(),
    };
    owned.exited = new Promise<void>((resolve) => {
      const finish = (error?: Error) => {
        if (owned.groupClosed) return;
        // Close a group as soon as its leader exits. Do not retain an exited
        // helper PID for signaling later after the OS might have reused it.
        signalGroup(child, "SIGKILL");
        owned.groupClosed = true;
        owned.error = error;
        if (service && !closing) controller.abort(processError(owned));
        resolve();
      };
      child.once("error", finish);
      child.once("exit", () => finish());
    });
    processes.push(owned);
    manifest();
    return owned;
  }

  async function execute(name: string, command: string[]) {
    const owned = launch(name, command, false);
    await Promise.race([owned.exited, interrupted]);
    if (owned.error || owned.child.exitCode !== 0) throw processError(owned);
  }

  async function waitForName(address: string, destination: string) {
    // gdbus handles ownership and D-Bus types. Retry only while the socket is
    // starting; successful name ownership, never elapsed time, is readiness.
    for (;;) {
      controller.signal.throwIfAborted();
      try {
        await execute("readiness", [...config.gdbus, "wait", "--address", address, destination]);
        return;
      } catch (error) {
        controller.signal.throwIfAborted();
        if (!(error instanceof Error)) throw error;
        await delay(20, undefined, { signal: controller.signal });
      }
    }
  }

  try {
    for (const [variable, directory] of Object.entries({
      XDG_CONFIG_HOME: "config",
      XDG_CACHE_HOME: "cache",
      XDG_RUNTIME_DIR: "runtime",
      XDG_DATA_HOME: "data",
      XDG_STATE_HOME: "state",
      XDG_CONFIG_DIRS: "config-dirs",
    })) {
      env[variable] = join(resourceDir, directory);
      mkdirSync(env[variable]!, { mode: 0o700 });
    }
    env["DBUS_SESSION_BUS_ADDRESS"] = sessionAddress;
    env["IBUS_ADDRESS"] = ibusAddress;
    env["IBUS_ADDRESS_FILE"] = join(resourceDir, "ibus-address");
    env["GSETTINGS_BACKEND"] = "keyfile";
    env["DCONF_PROFILE"] = join(resourceDir, "dconf-profile");
    writeFileSync(env["DCONF_PROFILE"], "user-db:ibus-test\n");
    env["XDG_DATA_DIRS"] = config.env["XDG_DATA_DIRS"] ?? env["XDG_DATA_HOME"];
    // Prevent display discovery and inherited alternate backend paths.
    for (const variable of [
      "DISPLAY",
      "WAYLAND_DISPLAY",
      "DBUS_STARTER_ADDRESS",
      "DBUS_STARTER_BUS_TYPE",
      "IBUS_USE_PORTAL",
      "IBUS_SESSION_ID",
    ])
      delete env[variable];
    writeFileSync(join(artifactDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
    manifest();
    launch("session-bus", [...config.sessionBus, "--nofork", `--address=${sessionAddress}`], true);
    await waitForName(sessionAddress, "org.freedesktop.DBus");
    launch("ibus-daemon", [...config.daemon, "--address", ibusAddress], true);
    await waitForName(ibusAddress, config.daemonDestination);
    if (config.configService) {
      launch("config-service", config.configService.command, true);
      await waitForName(ibusAddress, config.configService.destination);
    }
    for (const setting of settings) {
      await execute("settings", [...config.gsettings, "set", setting.schema, setting.key, setting.value]);
    }
    launch("engine", config.engine, true);
    await waitForName(ibusAddress, config.destination);
    clearTimeout(startupDeadline);
    const adapterCommand = [
      ...config.adapter,
      "--address",
      ibusAddress,
      "--destination",
      config.destination,
      "--factory",
      config.factory,
      "--timeout-ms",
      String(config.timeoutMs),
    ];
    const session: NativeSession = {
      env,
      adapterCommand,
      artifactDir,
      resourceDir,
      signal: controller.signal,
      run(trace) {
        controller.signal.throwIfAborted();
        const result = runAdapter(adapterCommand, trace, {
          env,
          signal: controller.signal,
          timeoutMs: config.timeoutMs,
          artifactDir: join(artifactDir, `run-${runNumber++}`),
        });
        adapters.add(result);
        void result.finally(() => adapters.delete(result)).catch(() => {});
        return result;
      },
    };
    callback = use(session);
    return await Promise.race([callback, interrupted]);
  } finally {
    clearTimeout(startupDeadline);
    options.signal?.removeEventListener("abort", onAbort);
    controller.abort(new Error("native session closed"));
    // Cancellation is immediate, but cooperative callback cleanup still owns
    // the services and files. Preserve the race's primary result or error if
    // that cleanup rejects while we wait for its lifetime to finish.
    await callback?.catch(() => {});
    closing = true;
    for (const owned of [...processes].reverse()) {
      if (!owned.groupClosed) signalGroup(owned.child, "SIGTERM");
    }
    await Promise.race([Promise.all(processes.map(({ exited }) => exited)), delay(200)]);
    for (const owned of [...processes].reverse()) {
      if (!owned.groupClosed) signalGroup(owned.child, "SIGKILL");
    }
    await Promise.all(processes.map(({ exited }) => exited));
    await Promise.allSettled(adapters);
    try {
      manifest();
    } finally {
      rmSync(resourceDir, { recursive: true, force: true });
    }
  }
}
