// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import type { ModuleManifest } from "@ibus-web/protocol";
import { check, withString, type RuntimeHandle } from "./runtime.ts";

// Points GLib at the engine's settings schemas, which the data install
// mounts under /nix/store. It must run before Init: GLib caches its default
// schema source on first use.
export const setSchemaDir = (handle: RuntimeHandle, manifest: ModuleManifest): void => {
  withString(handle, "GSETTINGS_SCHEMA_DIR", (name) =>
    withString(handle, manifest.settingsSchemaDir, (value) =>
      check("setenv GSETTINGS_SCHEMA_DIR", handle.rt._setenv(name, value, 1)),
    ),
  );
};
