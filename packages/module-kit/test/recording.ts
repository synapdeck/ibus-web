// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// A stand-in for the Worker host: it creates an engine's sessions with
// contexts that record each output call, keeps the engine's settings store,
// and tells every open session of each change, as the host does.

import type {
  EngineContext,
  EngineSession,
  ModuleEngine,
  SettingDeclaration,
  SettingValue,
} from "@ibus-web/protocol/module-script";

/** An output call a session made on its context, by method name, with its arguments. */
export interface Call {
  readonly method: string;
  readonly args: readonly unknown[];
}

export interface Timer {
  readonly ms: number;
  readonly fn: () => void;
  cancelled: boolean;
}

export interface RecordedSession {
  /** The host's view of the session: what the engine's create returned. */
  readonly session: EngineSession;
  readonly calls: Call[];
  readonly timers: Timer[];
}

const equal = (a: SettingValue, b: SettingValue): boolean =>
  typeof a === "object" && typeof b === "object"
    ? a.length === b.length && a.every((item, index) => item === b[index])
    : Object.is(a, b);

export const recordingHost = (engine: ModuleEngine) => {
  const declarations: Readonly<Record<string, SettingDeclaration>> = engine.settings ?? {};
  const values = new Map<string, SettingValue>(
    Object.entries(declarations).map(([key, declaration]) => [key, declaration.default]),
  );
  const sessions: RecordedSession[] = [];
  const pending: (readonly [string, SettingValue])[] = [];

  // The values the sessions wrote, in order, for the page to persist.
  const written: (readonly [string, SettingValue])[] = [];

  const declared = (key: string): void => {
    if (!Object.hasOwn(declarations, key)) throw new Error(`no setting ${key}`);
  };

  const store = (key: string, value: SettingValue): void => {
    if (equal(values.get(key)!, value)) return;

    values.set(key, value);
    pending.push([key, value]);
  };

  // A session's own writes reach the sessions once the call that made them
  // has returned, and changes made meanwhile in turn.
  const deliver = (): void => {
    while (pending.length > 0) {
      const [key, value] = pending.shift()!;
      for (const { session } of sessions) session.settingChanged?.(key, value);
    }
  };

  const open = (): RecordedSession => {
    const calls: Call[] = [];
    const timers: Timer[] = [];
    const record =
      (method: string) =>
      (...args: unknown[]): void =>
        void calls.push({ method, args });

    const context: EngineContext = {
      commit: record("commit"),
      preedit: record("preedit"),
      auxiliary: record("auxiliary"),
      lookupTable: record("lookupTable"),
      registerProperties: record("registerProperties"),
      updateProperty: record("updateProperty"),
      forwardKey: record("forwardKey"),
      deleteSurrounding: record("deleteSurrounding"),
      requireSurrounding: record("requireSurrounding"),
      settings: {
        get(key) {
          declared(key);
          return values.get(key)!;
        },
        set(key, value) {
          declared(key);
          written.push([key, value]);
          store(key, value);
        },
      },
      after(ms, fn) {
        const timer: Timer = { ms, fn, cancelled: false };
        timers.push(timer);
        return () => void (timer.cancelled = true);
      },
      log: record("log"),
    };

    const recorded = { session: engine.create(context), calls, timers };
    sessions.push(recorded);
    return recorded;
  };

  return {
    values,
    written,
    open,
    /** Runs `fn` as the host serves a request, telling the sessions of the settings it changed once it returns. */
    serve<T>(fn: () => T): T {
      const result = fn();
      deliver();
      return result;
    },
    /** The page's change of a setting, which the sessions hear at once. */
    change(key: string, value: SettingValue): void {
      declared(key);
      store(key, value);
      deliver();
    },
  };
};
