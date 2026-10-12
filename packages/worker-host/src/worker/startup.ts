// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { decodeModuleManifest, type ModuleManifest } from "@ibus-web/protocol";
import type { HostInit, RuntimeConstants } from "../shared/messages.ts";
import { Schema } from "effect";
import { StartupFailed } from "./failure.ts";
import { nodeFs } from "./node-fs.ts";

export const checkManifest = (value: unknown, constants: RuntimeConstants): ModuleManifest => {
  let manifest: ModuleManifest;
  try {
    manifest = decodeModuleManifest(value, constants.memory);
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
export const readManifest = async (
  init: HostInit<unknown, unknown>,
  constants: RuntimeConstants,
): Promise<ModuleManifest> => {
  if (init.manifest !== undefined) return checkManifest(init.manifest, constants);
  if (init.manifestUrl === undefined) throw new StartupFailed({ message: "manifest or manifestUrl is required" });
  const response = await fetch(init.manifestUrl);
  if (!response.ok) throw new StartupFailed({ message: `fetch manifest: ${response.status}` });
  const manifest = checkManifest(await response.json(), constants);
  // Synthetic Responses have no URL; network responses include redirects.
  const base = response.url || init.manifestUrl;
  return {
    ...manifest,
    module: { ...manifest.module, url: new URL(manifest.module.url, base).href },
    data: manifest.data.map((entry) => ({ ...entry, url: new URL(entry.url, base).href })),
  };
};

const integer = Schema.Number.check(Schema.isInt());
const count = integer.check(Schema.isGreaterThanOrEqualTo(0));
const memoryBytes = count.check(Schema.isGreaterThan(0), Schema.isMultipleOf(65536));
const runtimeConstants = Schema.Struct({
  runtimeAbi: count,
  protocol: count,
  canceled: integer,
  pumpError: integer,
  waitTimedOut: integer,
  idbReadOnly: count,
  memory: Schema.Struct({ minimum: memoryBytes, maximum: memoryBytes }),
  fs: Schema.Struct({
    errno: Schema.Struct({
      EEXIST: count,
      EFBIG: count,
      EINVAL: count,
      EISDIR: count,
      ENOENT: count,
      ENOTDIR: count,
      EOPNOTSUPP: count,
    }),
    open: Schema.Struct({ O_WRONLY: count, O_CREAT: count, O_TRUNC: count, O_NOFOLLOW: count }),
    mode: Schema.Struct({ S_IFMT: count, S_IFDIR: count, S_IFLNK: count }),
  }),
  poolLowWater: count,
});

export type RuntimeDistributionConstants = RuntimeConstants & { poolLowWater: number };

// Node imports the runtime from disk; browsers fetch its distribution by URL.
export const readRuntimeConstants = async (runtimeUrl: string): Promise<RuntimeDistributionConstants> => {
  let url: URL | undefined;
  try {
    url = new URL("constants.json", runtimeUrl);
    const text =
      url.protocol === "file:"
        ? await (await nodeFs()).readFile(url, "utf8")
        : new TextDecoder().decode(await fetchBytes(url.href));
    const constants = Schema.decodeUnknownSync(runtimeConstants)(JSON.parse(text));
    if (constants.memory.minimum > constants.memory.maximum) throw new Error("minimum memory exceeds maximum");
    return constants;
  } catch (error) {
    throw new StartupFailed({ message: `constants.json (${url?.href ?? runtimeUrl}): ${String(error)}` });
  }
};
