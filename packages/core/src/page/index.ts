// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
export {
  Connection,
  ConnectionBusyError,
  type ConnectionOptions,
  type CrashInfo,
  type Reply,
  type SyncOutcome,
} from "../connection/connection.ts";
export {
  codepointForKeysym,
  evdevForCode,
  keysymByName,
  keysymForCodepoint,
  translateKey,
  validateKeyboard,
  type KeyLike,
} from "../keys/index.ts";
export {
  ReplayQueue,
  type AsyncKeyResult,
  type KeyResult,
  type KeySink,
  type Preedit,
  type PreeditAttribute,
  type SurfaceAdapter,
} from "../router/replay.ts";
export {
  KeyRouter,
  type KeyboardPolicy,
  type ModuleSnapshot,
  type ModuleState,
  type KeyConnection,
  type KeyContext,
  type RouterOutput,
} from "../router/keystroke.ts";
export { CoreConfig, type CoreConfigValues } from "../services/config.ts";
export {
  ModuleRegistry,
  makeModuleRegistry,
  type ModuleEvent,
  type ModuleRegistryOptions,
  type ModuleRegistryService,
} from "../services/modules.ts";
export {
  SettingsSource,
  type SettingsChange,
  type SettingsSnapshot,
  type SettingsSourceService,
} from "../services/settings.ts";
export { Logger, PanelEvents, glibLevel, type LogLine } from "../services/logging.ts";
export { Router, makeRouter, type AttachOptions, type HotkeyRegistry, type RouterService } from "../router/router.ts";
export { textareaAdapter } from "../adapters/textarea.ts";
export {
  SettingsApi,
  type SettingsApiService,
  type SettingsOptions,
  type SettingsSchema,
  type SettingsKey,
  type SettingValue,
} from "../settings/api.ts";
export { indexedDbSettings } from "../settings/persister.ts";
export type { PanelEvent, PanelRecord } from "@ibus-web/protocol";
