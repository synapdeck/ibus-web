// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The backend for a JavaScript module: its script's engines, run on the
// host's own thread, with nothing between the page's wake word and the
// host's wait. The page reads its replies and records as the runtime ABI
// defines them, so each request returns the errno ibusweb_dispatch()
// documents for it, and the engines' output is framed as those records.

import {
  CommitText,
  CrashReason,
  CreateEngineFailed,
  decodeRequest,
  DeleteSurroundingText,
  encodeRecord,
  errorMessage,
  errorReport,
  ForwardKeyEvent,
  Log,
  PROTOCOL_VERSION,
  RegisterProperties,
  RequireSurroundingText,
  requestKinds,
  SettingWritten,
  UpdateAuxiliaryText,
  UpdateLookupTable,
  UpdatePreeditText,
  UpdateProperty,
  type JsModuleManifest,
  type OutputRecord,
  type Request,
} from "@ibus-web/protocol";
import type { EngineContext, EngineSession, ModuleScript } from "@ibus-web/protocol/module-script";
import { Word } from "@ibus-web/protocol/transport";
import type { ControlViews } from "../shared/control.ts";
import type { Backend, Dispatched } from "./backend.ts";
import { RuntimeStopped } from "./failure.ts";
import {
  ibusPropList,
  ibusProperty,
  ibusText,
  logLevel,
  lookupTable,
  preeditMode,
  propertyState,
} from "./js-records.ts";
import { settingsStore, type SettingChange } from "./js-settings.ts";
import { keyCharacter } from "./key-character.ts";
import { publishRecords, recordText, type OutputRing } from "./output.ts";

interface JsBackendInit {
  readonly manifest: JsModuleManifest;
  // The script's default export, checked against the manifest.
  readonly script: ModuleScript;
  readonly control: ControlViews;
  readonly ring: OutputRing;
  // A monotonic clock in milliseconds.
  readonly now?: () => number;
  // The sequence number the first record follows, 0 but in tests that
  // start near the wrap.
  readonly initialSeq?: number;
}

// Emscripten's errno values, the numbering the runtime ABI's replies use.
const EALREADY = 7;
const EBADMSG = 9;
const ECANCELED = 11;
const EEXIST = 20;
const EINVAL = 28;
const EIO = 29;
const ENOENT = 44;
const ENOSYS = 52;
const ENOTCONN = 53;
const ENOTRECOVERABLE = 56;
const EPROTO = 65;
const ESRCH = 71;
const ESHUTDOWN = 140;

const knownKinds = new Set(requestKinds.values());

// GLib's WARNING, in the domain the page reads as the host's own warnings.
const WARNING = 1 << 4;
const warningDomain = "ibus-web";

// Thrown out of a call into the module that threw, once the fault is
// recorded, so the request it served stops there.
class Faulted extends Error {}

// What a throw from the module says, as text a record carries, whatever was
// thrown: the throw's own getters and toString run here, outside any call.
const thrownText = (render: (error: unknown) => string, error: unknown): string => {
  try {
    return recordText(String(render(error)));
  } catch {
    return "an unprintable error";
  }
};

interface Session {
  readonly engine: string;
  readonly handlers: EngineSession;
  // Cleared once the session is destroyed, after which its context writes
  // nothing.
  readonly open: { value: boolean };
  // IBus's content type starts at 0 and 0, and the engine hears only of a
  // change.
  purpose: number;
  hints: number;
}

// A call a session scheduled with `after`.
interface Timer {
  // The session's `open`, which names the session without the map's key.
  readonly owner: { value: boolean };
  readonly who: string;
  readonly due: number;
  readonly fn: () => void;
}

export const jsBackend = ({
  manifest,
  script,
  control,
  ring,
  now = () => performance.now(),
  initialSeq = 0,
}: JsBackendInit): Backend => {
  const wake = { words: control.words, index: Word.wake };
  const wait = (seen: number, timeoutMs: number): boolean =>
    Atomics.wait(control.words, Word.wake, seen, timeoutMs < 0 ? Infinity : timeoutMs) !== "timed-out";

  const sessions = new Map<number, Session>();
  // Framed with sequence number 0, which drain replaces.
  let queued: Uint8Array[] = [];
  let lastSeq = initialSeq;
  let initialized = false;
  let shutDown = false;
  let fault: string | undefined;

  const queue = (ic: number, record: OutputRecord): void => {
    queued.push(encodeRecord(0, ic, record));
  };

  const settings = settingsStore(script, (message) =>
    queue(0, new Log({ level: WARNING, domain: warningDomain, message })),
  );
  // Changes waiting for the request that made them to return, so that no
  // session hears of one inside the call that made it.
  let changes: SettingChange[] = [];
  // In the order scheduled, which breaks ties between timers due together.
  const timers = new Set<Timer>();

  // Runs a call into the module. The first throw faults it for good.
  const call = <T>(who: string, run: () => T): T => {
    try {
      return run();
    } catch (error) {
      fault ??= recordText(`${who} threw: ${thrownText(errorReport, error)}`);
      throw new Faulted();
    }
  };

  // Records are made at the call, so a value the records can't carry throws
  // inside the module's own call.
  const context = (ic: number, engine: string, open: { value: boolean }): EngineContext => {
    const write = (record: () => OutputRecord): void => {
      if (open.value) queue(ic, record());
    };

    return {
      commit: (text) => write(() => new CommitText({ text: ibusText(text) })),
      preedit: (text, cursor, visible, mode) =>
        write(() => new UpdatePreeditText({ text: ibusText(text), cursor, visible, mode: preeditMode(mode) })),
      auxiliary: (text, visible) => write(() => new UpdateAuxiliaryText({ text: ibusText(text), visible })),
      lookupTable: (page, visible) => write(() => new UpdateLookupTable({ table: lookupTable(page), visible })),
      registerProperties: (properties) => write(() => new RegisterProperties({ properties: ibusPropList(properties) })),
      updateProperty: (property) => write(() => new UpdateProperty({ property: ibusProperty(property) })),
      forwardKey: (keyval, keycode, state) => write(() => new ForwardKeyEvent({ keyval, keycode, state })),
      deleteSurrounding: (offset, count) => write(() => new DeleteSurroundingText({ offset, count })),
      requireSurrounding: () => write(() => new RequireSurroundingText({})),
      settings: {
        get: (key) => settings.get(engine, key),
        set: (key, value) => {
          if (!open.value) return;

          const written = settings.set(engine, key, value);
          if (written === undefined) return;

          queue(ic, new SettingWritten({ path: written.path, key, value: written.value }));
          if (written.change !== undefined) changes.push(written.change);
        },
      },
      after: (ms, fn) => {
        if (typeof ms !== "number" || !(ms >= 0) || ms === Infinity)
          throw new TypeError(`after needs a delay of finitely many milliseconds, not ${String(ms)}`);
        if (typeof fn !== "function") throw new TypeError("after needs a function to run");
        if (!open.value) return () => {};

        const timer: Timer = { owner: open, who: `engine ${engine}`, due: now() + ms, fn };
        timers.add(timer);
        return () => void timers.delete(timer);
      },
      log: (level, message) => {
        if (typeof message !== "string") throw new TypeError(`log needs a string message, not ${typeof message}`);
        return write(() => new Log({ level: logLevel(level), domain: manifest.name, message: recordText(message) }));
      },
    };
  };

  const dropTimers = (owner: { value: boolean }): void => {
    for (const timer of timers) if (timer.owner === owner) timers.delete(timer);
  };

  const createEngine = (ic: number, name: string): number => {
    if (sessions.has(ic)) return -EEXIST;
    if (!Object.hasOwn(script.engines, name)) return -ESRCH;

    const open = { value: true };
    const failed = (message: string): number => {
      open.value = false;
      dropTimers(open);
      queue(ic, new CreateEngineFailed({ message: recordText(message) }));
      return -EIO;
    };

    let handlers: unknown;
    try {
      handlers = script.engines[name]!.create(context(ic, name, open));
    } catch (error) {
      return failed(thrownText(errorMessage, error));
    }
    if (typeof handlers !== "object" || handlers === null) return failed(`engine ${name}'s create returned no session`);

    sessions.set(ic, { engine: name, handlers: handlers as EngineSession, open, purpose: 0, hints: 0 });
    return 0;
  };

  const destroy = (ic: number, session: Session): void => {
    sessions.delete(ic);
    dropTimers(session.open);
    try {
      call(`engine ${session.engine}`, () => session.handlers.destroy?.());
    } finally {
      session.open.value = false;
    }
  };

  // Tells every live session of a changed key's engine, the writer's
  // included, as GSettings fires a write's own changed signal. Changes the
  // sessions make meanwhile are told in turn.
  const deliver = (): void => {
    while (changes.length > 0) {
      const { engine, key, value } = changes.shift()!;
      for (const session of sessions.values())
        if (session.engine === engine && session.open.value)
          call(`engine ${engine}`, () => session.handlers.settingChanged?.(key, value));
    }
  };

  const settingChanged = ({ path, key, value }: Extract<Request, { _tag: "SettingChanged" }>): number => {
    const result = settings.change(path, key, value);
    if (result._tag === "Unknown") return -ENOENT;
    if (result._tag === "Invalid") return -EINVAL;

    if (result.change !== undefined) changes.push(result.change);
    return 0;
  };

  // A request for an open session, by kind.
  const serveSession = (ic: number, session: Session, request: Request): number => {
    const { handlers } = session;
    const engine = <T>(run: () => T): T => call(`engine ${session.engine}`, run);

    switch (request._tag) {
      case "DestroyEngine":
        destroy(ic, session);
        return 0;
      case "ProcessKeyEvent": {
        const { keyval, keycode, state } = request;
        return engine(() => handlers.processKey?.(keyval, keycode, state, keyCharacter(keyval))) ? 1 : 0;
      }
      case "FocusIn":
        engine(() => handlers.focusIn?.());
        return 0;
      case "FocusOut":
        engine(() => handlers.focusOut?.());
        return 0;
      case "Reset":
        engine(() => handlers.reset?.());
        return 0;
      case "Enable":
        engine(() => handlers.enable?.());
        return 0;
      case "Disable":
        engine(() => handlers.disable?.());
        return 0;
      case "SetCursorLocation": {
        const { x, y, width, height } = request;
        engine(() => handlers.setCursorLocation?.(x, y, width, height));
        return 0;
      }
      case "SetCapabilities":
        engine(() => handlers.setCapabilities?.(request.capabilities));
        return 0;
      case "PageUp":
        engine(() => handlers.pageUp?.());
        return 0;
      case "PageDown":
        engine(() => handlers.pageDown?.());
        return 0;
      case "CursorUp":
        engine(() => handlers.cursorUp?.());
        return 0;
      case "CursorDown":
        engine(() => handlers.cursorDown?.());
        return 0;
      case "CandidateClicked": {
        const { index, button, state } = request;
        engine(() => handlers.candidateClicked?.(index, button, state));
        return 0;
      }
      case "PropertyActivate":
        engine(() => handlers.propertyActivate?.(request.name, propertyState(request.state)));
        return 0;
      case "SetSurroundingText": {
        const { text } = request.text;
        const { cursor, anchor } = request;
        const length = [...text].length;
        if (cursor > length || anchor > length) return -EINVAL;

        engine(() => handlers.setSurroundingText?.(text, cursor, anchor));
        return 0;
      }
      case "SetContentType": {
        const { purpose, hints } = request;
        if (purpose === session.purpose && hints === session.hints) return 0;

        session.purpose = purpose;
        session.hints = hints;
        engine(() => handlers.setContentType?.(purpose, hints));
        return 0;
      }
      default:
        return -ENOSYS;
    }
  };

  // The checks the runtime ABI documents, in the order it gives them, which
  // decides the errno of a request several would refuse.
  const serve = (ic: number, request: Request): number => {
    if (request._tag === "Init") {
      if (initialized) return -EALREADY;
      if (request.version !== PROTOCOL_VERSION) return -EPROTO;

      settings.init(request);
      initialized = true;
      return 0;
    }

    if (!initialized) return -ENOTCONN;

    switch (request._tag) {
      case "SettingChanged":
        return settingChanged(request);
      case "Persist":
        call("the module's persist", () => script.persist?.());
        return 0;
      case "Shutdown":
        shutDown = true;
        call("the module's shutdown", () => script.shutdown?.());
        // No engine hears of anything afterwards, a write shutdown made
        // included; the write's record still goes to the page.
        changes = [];
        return 0;
      case "CreateEngine":
        return createEngine(ic, request.name);
    }

    const session = sessions.get(ic);
    return session === undefined ? -ENOENT : serveSession(ic, session, request);
  };

  const dispatch = (bytes: Uint8Array): Dispatched => {
    if (fault !== undefined) return { ret: -ENOTRECOVERABLE };
    if (shutDown) return { ret: -ESHUTDOWN };
    if (bytes.length < 8) return { ret: -EBADMSG };

    const header = new DataView(bytes.buffer, bytes.byteOffset, 8);
    if (header.getUint16(2, true) !== 0) return { ret: -EBADMSG };
    if (!knownKinds.has(header.getUint16(0, true))) return { ret: -ENOSYS };

    let decoded: ReturnType<typeof decodeRequest>;
    try {
      decoded = decodeRequest(bytes);
    } catch {
      return { ret: -EBADMSG };
    }

    try {
      const ret = serve(decoded.ic, decoded.request);
      deliver();
      return { ret };
    } catch (error) {
      if (error instanceof Faulted) {
        changes = [];
        return { ret: -ECANCELED, fault: fault! };
      }
      throw error;
    }
  };

  // Numbers the queued records from 1, skipping zero as the sequence wraps,
  // since a record numbered 0 is the host's own.
  const drain = (): number => {
    if (queued.length === 0) return 0;

    const records = queued;
    queued = [];
    const batch = new Uint8Array(records.reduce((total, record) => total + record.length, 0));
    let offset = 0;
    for (const record of records) {
      lastSeq = lastSeq === 0xffffffff ? 1 : lastSeq + 1;
      new DataView(record.buffer, record.byteOffset, 4).setUint32(0, lastSeq, true);
      batch.set(record, offset);
      offset += record.length;
    }
    return publishRecords(ring.writer, batch, ring, { wake, wait });
  };

  // Runs the timers due, in due order, then tells the sessions of the
  // settings they changed. A timer scheduled meanwhile waits for the next
  // pump, so one that reschedules itself can't hold the host here.
  const pump = (): number => {
    if (fault !== undefined || shutDown) return -1;

    try {
      const at = now();
      const due = [...timers].filter((timer) => timer.due <= at).sort((a, b) => a.due - b.due);
      for (const timer of due) {
        // An earlier timer may have cancelled this one or destroyed its
        // session.
        if (!timers.delete(timer) || !timer.owner.value) continue;
        call(timer.who, timer.fn);
      }
      deliver();
    } catch (error) {
      if (!(error instanceof Faulted)) throw error;

      changes = [];
      return -1;
    }

    let next = Infinity;
    for (const timer of timers) next = Math.min(next, timer.due);
    return next === Infinity ? -1 : Math.max(0, Math.ceil(next - now()));
  };

  // Destroying sessions as the host closes reaches the module, so it is
  // skipped once the module has faulted or shut down.
  const close = (intact: boolean): void => {
    const open = [...sessions];
    sessions.clear();
    timers.clear();
    if (!intact || fault !== undefined || shutDown) return;

    try {
      for (const [ic, session] of open) destroy(ic, session);
    } catch (error) {
      if (error instanceof Faulted) throw new RuntimeStopped({ error: fault!, reason: CrashReason.fault });
      throw error;
    }
  };

  return {
    wake,
    dispatch,
    pump,
    drain,
    wait,
    fault: () => fault,
    pool: undefined,
    close,
  };
};
