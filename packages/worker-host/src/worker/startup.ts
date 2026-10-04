// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { decodeEngineManifest, type EngineManifest } from "@ibus-web/protocol";
import type { HostInit, RuntimeConstants } from "../shared/messages.ts";
import { StartupFailed } from "./failure.ts";

export const checkManifest = (value: unknown, constants: RuntimeConstants): EngineManifest => {
  let manifest: EngineManifest;
  try {
    manifest = decodeEngineManifest(value, constants.memory);
  } catch (error) {
    throw new StartupFailed({
      message: `manifest (memory bounds ${constants.memory.minimum} to ${constants.memory.maximum} bytes): ${String(error)}`,
    });
  }
  if (manifest.runtimeAbi !== constants.runtimeAbi)
    throw new StartupFailed({
      message: `RuntimeAbiMismatch: manifest ${manifest.runtimeAbi}, runtime ${constants.runtimeAbi}`,
    });
  if (manifest.protocol !== constants.protocol)
    throw new StartupFailed({
      message: `ProtocolMismatch: manifest ${manifest.protocol}, runtime ${constants.protocol}`,
    });
  return manifest;
};

export const fetchBytes = async (url: string): Promise<Uint8Array> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch ${url}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
};

// Relative asset URLs are interpreted against the fetched manifest, not the
// Worker's script. Inline manifests already carry URLs resolved by the page.
export const readManifest = async (init: HostInit<unknown, unknown>): Promise<EngineManifest> => {
  if (init.manifest !== undefined) return checkManifest(init.manifest, init.constants);
  if (init.manifestUrl === undefined) throw new StartupFailed({ message: "manifest or manifestUrl is required" });
  const response = await fetch(init.manifestUrl);
  if (!response.ok) throw new StartupFailed({ message: `fetch manifest: ${response.status}` });
  const manifest = checkManifest(await response.json(), init.constants);
  return {
    ...manifest,
    module: { ...manifest.module, url: new URL(manifest.module.url, init.manifestUrl).href },
    data: manifest.data.map((entry) => ({ ...entry, url: new URL(entry.url, init.manifestUrl).href })),
  };
};
