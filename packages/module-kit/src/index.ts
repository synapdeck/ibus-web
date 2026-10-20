// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

export { MODULE_ABI } from "@ibus-web/protocol/module-script";
export {
  defineEngine,
  type Candidate,
  type CandidateCursor,
  type CandidatesOptions,
  type Engine,
  type EngineContext,
  type EngineDefinition,
  type EngineDescriptor,
  type EngineSession,
  type EngineSettings,
  type PropertyChanges,
  type PropertyDefinition,
} from "./engine.ts";
export { ModuleDefinitionError, type ModuleDefinitionErrorFields } from "./errors.ts";
export { defineModule, type Engines, type Module, type ModuleDefinition } from "./module.ts";
export { transformEngine, type TransformDefinition, type Transformed } from "./transform.ts";
export type {
  GSettingsKey,
  NoSettings,
  SettingName,
  SettingProperty,
  SettingsDeclaration,
  SettingsSchema,
} from "./settings.ts";
