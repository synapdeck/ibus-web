// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import type { EngineManifest } from "@ibus-web/protocol";
import { check, withString, type RuntimeHandle } from "./runtime.ts";

// Install mounts the version's database at /nix/store. Set the schema path
// before Init, because GLib caches its default schema source on first use.
export const mountStore = (handle: RuntimeHandle, manifest: EngineManifest): void => {
  withString(handle, "GSETTINGS_SCHEMA_DIR", (name) =>
    withString(handle, manifest.settingsSchemaDir, (value) =>
      check("setenv GSETTINGS_SCHEMA_DIR", handle.rt._setenv(name, value, 1)),
    ),
  );
};
