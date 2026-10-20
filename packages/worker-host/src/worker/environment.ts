// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import type { WasmModuleManifest } from "@ibus-web/protocol";
import { engineDir } from "../shared/naming.ts";
import { check, withString, type RuntimeHandle } from "./runtime.ts";

const setenv = (handle: RuntimeHandle, name: string, value: string): void => {
  withString(handle, name, (namePtr) =>
    withString(handle, value, (valuePtr) => check(`setenv ${name}`, handle.rt._setenv(namePtr, valuePtr, 1))),
  );
};

// Points GLib at the engine's settings schemas, which the data install
// mounts under /nix/store, and makes the engine's own files its home. It
// must run before Init: GLib caches its default schema source and the home
// directory on first use.
export const setEnvironment = (handle: RuntimeHandle, manifest: WasmModuleManifest): void => {
  setenv(handle, "GSETTINGS_SCHEMA_DIR", manifest.settingsSchemaDir);
  setenv(handle, "HOME", engineDir(manifest));
};
