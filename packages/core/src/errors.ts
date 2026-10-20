// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Data } from "effect";
import type { CrashInfo } from "./connection/crash.ts";

/**
 * What every error of the family carries: the module, by the name the page's `modules` option gives it; the engine,
 * where the failure was one engine's; and the Worker's or the engine's own account of it.
 */
export interface IbusWebErrorFields {
  readonly module: string;
  readonly engine?: string;
  readonly diagnostic?: string;
}

/** Why a module's Worker crashed: the host's Crashed record's reason, or HOST for a Worker the page lost. */
export type CrashReasonName = "TRAP" | "FAULT" | "RELAY" | "LOAD" | "HOST";

const describe = (what: string, { module, engine, diagnostic }: IbusWebErrorFields): string =>
  `${engine === undefined ? `Module ${module}` : `Engine ${engine} of module ${module}`} ${what}` +
  (diagnostic === undefined ? "" : `: ${diagnostic}`);

type Message = { readonly message: string };

/** The module couldn't be loaded: its manifest, Worker, runtime, storage or `Init` failed. */
export class EngineLoadFailed extends Data.TaggedError("EngineLoadFailed")<IbusWebErrorFields & Message> {
  constructor(fields: IbusWebErrorFields) {
    super({ ...fields, message: describe("failed to load", fields) });
  }
}

/** The module was built against another runtime: its ABI number or identity differs from the runtime's. */
export class RuntimeAbiMismatch extends Data.TaggedError("RuntimeAbiMismatch")<IbusWebErrorFields & Message> {
  constructor(fields: IbusWebErrorFields) {
    super({ ...fields, message: describe("was built for another runtime", fields) });
  }
}

/** The module script was built against another module ABI than the host's: its manifest's or its own differs. */
export class ModuleAbiMismatch extends Data.TaggedError("ModuleAbiMismatch")<IbusWebErrorFields & Message> {
  constructor(fields: IbusWebErrorFields) {
    super({ ...fields, message: describe("was built for another module ABI", fields) });
  }
}

/** The module speaks another protocol version than the page or the runtime. */
export class ProtocolMismatch extends Data.TaggedError("ProtocolMismatch")<IbusWebErrorFields & Message> {
  constructor(fields: IbusWebErrorFields) {
    super({ ...fields, message: describe("speaks another protocol version", fields) });
  }
}

/** The module's Worker crashed; `reason` says how, and `diagnostic` carries the Worker's report. */
export class EngineCrashed extends Data.TaggedError("EngineCrashed")<
  IbusWebErrorFields & Message & { readonly reason: CrashReasonName }
> {
  constructor(fields: IbusWebErrorFields & { readonly reason: CrashReasonName }) {
    super({ ...fields, message: describe(`crashed (${fields.reason})`, fields) });
  }
}

/** The module's Worker stopped answering, or more keys waited on it than the page holds, and was ended. */
export class EngineHung extends Data.TaggedError("EngineHung")<IbusWebErrorFields & Message> {
  constructor(fields: IbusWebErrorFields) {
    super({ ...fields, message: describe("stopped answering", fields) });
  }
}

/** A message to or from the module's Worker broke the protocol, such as a request too large for its slot. */
export class ProtocolError extends Data.TaggedError("ProtocolError")<IbusWebErrorFields & Message> {
  constructor(fields: IbusWebErrorFields) {
    super({ ...fields, message: describe("broke the protocol", fields) });
  }
}

/** Storage the call needs can't be used: the settings store, or a module's user data. */
export class StorageUnavailable extends Data.TaggedError("StorageUnavailable")<IbusWebErrorFields & Message> {
  constructor(fields: IbusWebErrorFields) {
    super({ ...fields, message: describe("has no usable storage", fields) });
  }
}

/** A surface's engine failed to start; `diagnostic` is the engine's own reason, when it gave one. */
export class CreateEngineError extends Data.TaggedError("CreateEngineError")<
  IbusWebErrorFields & Message & { readonly engine: string }
> {
  constructor(fields: IbusWebErrorFields & { readonly engine: string }) {
    super({ ...fields, message: describe("could not be created", fields) });
  }
}

/** An engine's own data failed to install; `diagnostic` is the Worker's reason. */
export class PrepareEngineError extends Data.TaggedError("PrepareEngineError")<
  IbusWebErrorFields & Message & { readonly engine: string }
> {
  constructor(fields: IbusWebErrorFields & { readonly engine: string }) {
    super({ ...fields, message: describe("could not be prepared", fields) });
  }
}

export type IbusWebError =
  | EngineLoadFailed
  | RuntimeAbiMismatch
  | ModuleAbiMismatch
  | ProtocolMismatch
  | EngineCrashed
  | EngineHung
  | ProtocolError
  | StorageUnavailable
  | CreateEngineError
  | PrepareEngineError;

const families: readonly (abstract new (...args: never[]) => IbusWebError)[] = [
  EngineLoadFailed,
  RuntimeAbiMismatch,
  ModuleAbiMismatch,
  ProtocolMismatch,
  EngineCrashed,
  EngineHung,
  ProtocolError,
  StorageUnavailable,
  CreateEngineError,
  PrepareEngineError,
];

export const isIbusWebError = (cause: unknown): cause is IbusWebError =>
  families.some((family) => cause instanceof family);

const crashReasons = {
  trap: "TRAP",
  fault: "FAULT",
  relay: "RELAY",
  load: "LOAD",
  host: "HOST",
  worker: "HOST",
} as const satisfies Record<Exclude<CrashInfo["reason"], "hang">, CrashReasonName>;

/** What a module's crash or hang reports, as the family's error. */
export const crashError = (module: string, { reason, message }: CrashInfo): EngineCrashed | EngineHung =>
  reason === "hang"
    ? new EngineHung({ module, diagnostic: message })
    : new EngineCrashed({ module, reason: crashReasons[reason], diagnostic: message });
