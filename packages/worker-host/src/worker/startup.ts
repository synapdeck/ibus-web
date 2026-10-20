// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import {
  decodeModuleManifest,
  JsModuleManifest,
  PROTOCOL_VERSION,
  type ModuleManifest,
  type WasmModuleManifest,
} from "@ibus-web/protocol";
import { MODULE_ABI } from "@ibus-web/protocol/module-script";
import type { HostInit, RuntimeConstants } from "../shared/messages.ts";
import { Schema } from "effect";
import { StartupFailed } from "./failure.ts";
import { nodeFs } from "./node-fs.ts";

// A WebAssembly module's manifest, checked against the runtime it runs on.
export const checkManifest = (value: unknown, constants: RuntimeConstants): WasmModuleManifest => {
  let manifest: ModuleManifest;
  try {
    manifest = decodeModuleManifest(value, constants.memory);
  } catch (error) {
    throw new StartupFailed({
      message: `manifest (memory bounds ${constants.memory.minimum} to ${constants.memory.maximum} bytes): ${String(error)}`,
      refused: "manifest",
    });
  }
  if (manifest.kind === "js")
    throw new StartupFailed({
      message: "manifest: a JavaScript module's, where a WebAssembly one's was expected",
      refused: "manifest",
    });

  if (manifest.runtimeAbi !== constants.runtimeAbi)
    throw new StartupFailed({
      message: `RuntimeAbiMismatch: manifest ${manifest.runtimeAbi}, runtime ${constants.runtimeAbi}`,
      refused: "RuntimeAbiMismatch",
    });
  if (manifest.runtimeIdentity !== constants.runtimeIdentity)
    throw new StartupFailed({
      message: `RuntimeAbiMismatch: manifest identity ${manifest.runtimeIdentity}, runtime ${constants.runtimeIdentity}`,
      refused: "RuntimeAbiMismatch",
    });
  if (manifest.protocol !== constants.protocol)
    throw new StartupFailed({
      message: `ProtocolMismatch: manifest ${manifest.protocol}, runtime ${constants.protocol}`,
      refused: "ProtocolMismatch",
    });
  return manifest;
};

// A JavaScript module runs on the host alone, so it must speak the host's
// own protocol and module ABI.
export const checkJsManifest = (value: unknown): JsModuleManifest => {
  let manifest: JsModuleManifest;
  try {
    manifest = Schema.decodeUnknownSync(JsModuleManifest, { onExcessProperty: "error" })(value);
  } catch (error) {
    throw new StartupFailed({ message: `manifest: ${String(error)}`, refused: "manifest" });
  }

  if (manifest.moduleAbi !== MODULE_ABI)
    throw new StartupFailed({
      message: `ModuleAbiMismatch: manifest ${manifest.moduleAbi}, host ${MODULE_ABI}`,
      refused: "ModuleAbiMismatch",
    });
  if (manifest.protocol !== PROTOCOL_VERSION)
    throw new StartupFailed({
      message: `ProtocolMismatch: manifest ${manifest.protocol}, host ${PROTOCOL_VERSION}`,
      refused: "ProtocolMismatch",
    });
  return manifest;
};

export const fetchBytes = async (url: string): Promise<Uint8Array> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch ${url}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
};

// The module a host starts: a JavaScript one, or a WebAssembly one with the
// constants of the runtime it runs on.
export type StartingModule =
  | { readonly kind: "js"; readonly manifest: JsModuleManifest }
  | {
      readonly kind: "wasm";
      readonly manifest: WasmModuleManifest;
      readonly constants: RuntimeDistributionConstants;
    };

const isJsManifest = (value: unknown): boolean =>
  typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "js";

// Relative asset URLs are interpreted against the fetched manifest, not the
// Worker's script. Inline manifests already carry URLs resolved by the page.
// The runtime's constants are read only for a WebAssembly module, which
// they are checked against.
export const readManifest = async (
  init: HostInit<unknown, unknown>,
  runtimeConstants: () => Promise<RuntimeDistributionConstants>,
): Promise<StartingModule> => {
  let value: unknown;
  let base: string | undefined;
  if (init.manifest !== undefined) value = init.manifest;
  else if (init.manifestUrl === undefined) throw new StartupFailed({ message: "manifest or manifestUrl is required" });
  else {
    const response = await fetch(init.manifestUrl);
    if (!response.ok) throw new StartupFailed({ message: `fetch manifest: ${response.status}` });
    value = await response.json();
    // Synthetic Responses have no URL; network responses include redirects.
    base = response.url || init.manifestUrl;
  }

  const resolve = (url: string): string => (base === undefined ? url : new URL(url, base).href);

  if (isJsManifest(value)) {
    const manifest = checkJsManifest(value);
    return { kind: "js", manifest: { ...manifest, module: { ...manifest.module, url: resolve(manifest.module.url) } } };
  }

  const constants = await runtimeConstants();
  const manifest = checkManifest(value, constants);
  return {
    kind: "wasm",
    constants,
    manifest: {
      ...manifest,
      module: { ...manifest.module, url: resolve(manifest.module.url) },
      data: manifest.data.map((entry) => ({ ...entry, url: resolve(entry.url) })),
    },
  };
};

const integer = Schema.Number.check(Schema.isInt());
const count = integer.check(Schema.isGreaterThanOrEqualTo(0));
const memoryBytes = count.check(Schema.isGreaterThan(0), Schema.isMultipleOf(65536));
const runtimeConstants = Schema.Struct({
  runtimeAbi: count,
  runtimeIdentity: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  protocol: count,
  canceled: integer,
  pumpError: integer,
  waitTimedOut: integer,
  idbReadOnly: count,
  memory: Schema.Struct({ minimum: memoryBytes, maximum: memoryBytes }),
  memoryFileBytes: count,
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
    mode: Schema.Struct({ S_IFMT: count, S_IFDIR: count, S_IFLNK: count, S_IFREG: count }),
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
