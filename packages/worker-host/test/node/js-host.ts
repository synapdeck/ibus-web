// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The host as released, started on a JavaScript module, and the page's side
// of its control buffer: one request at a time, and the records the ring
// holds.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  decodeRecord,
  encodeRequest,
  RingReader,
  transportLayout,
  type DecodedRecord,
  type JsModuleManifest,
  type Request,
  type TransportLayout,
} from "@ibus-web/protocol";
import { State, Word } from "@ibus-web/protocol/transport";
import { controlViews, createControl, postRequest, takeReply, type Reply } from "../../src/shared/control.ts";
import type { HostInit, HostMessage } from "../../src/shared/messages.ts";
import { BrowserWorker } from "./browser-worker.ts";

const hostUrl = new URL("../../dist/worker/index.js", import.meta.url);
const fixture = new URL("../fixtures/js-module/", import.meta.url);

export const scriptUrl = new URL("module.mjs", fixture).href;

export const manifest: JsModuleManifest = {
  ...(JSON.parse(readFileSync(new URL("manifest.json", fixture), "utf8")) as JsModuleManifest),
  module: { url: scriptUrl, size: 0 },
};

// Writes module scripts to a temporary directory, as manifests naming them.
export const scriptDirectory = (prefix: string) => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  return {
    manifest: (name: string, source: string): JsModuleManifest => {
      const path = join(directory, name);
      writeFileSync(path, source);
      return { ...manifest, module: { url: pathToFileURL(path).href, size: 0 } };
    },
    remove: () => rmSync(directory, { recursive: true, force: true }),
  };
};

// What a host posts as its start ends, and the host, still running.
export const start = (startOn: JsModuleManifest, layout?: TransportLayout) =>
  new Promise<{ worker: BrowserWorker; control: SharedArrayBuffer; message: HostMessage }>((resolve, reject) => {
    const control = createControl(layout);
    const worker = new BrowserWorker(hostUrl);
    worker.onmessage = ({ data }) => resolve({ worker, control, message: data as HostMessage });
    worker.onerror = ({ message }) => reject(new Error(message));
    const init: HostInit = {
      // A JavaScript module's host reads nothing of the runtime.
      runtimeUrl: "file:///nonexistent/ibus-runtime.js",
      control,
      storage: { kind: "none" },
      manifest: startOn,
      ...(layout === undefined ? {} : { layout }),
    };
    worker.postMessage(init);
  });

// The message a running host posts next.
export const next = (worker: BrowserWorker) =>
  new Promise<HostMessage>((resolve) => {
    worker.onmessage = ({ data }) => resolve(data as HostMessage);
  });

export interface Served extends Reply {
  // The records the host wrote serving the request.
  readonly records: readonly DecodedRecord[];
}

// The page's side of a host's control buffer. A reply to a request that
// crashed the host is read from its words, since CRASHED replaces the
// reply's state.
export const page = (control: SharedArrayBuffer, layout: TransportLayout = transportLayout()) => {
  const views = controlViews(control, layout);
  const reader = new RingReader(views, layout);

  const records = (): DecodedRecord[] => {
    const read: DecodedRecord[] = [];
    for (let bytes = reader.next(); bytes !== undefined; bytes = reader.next()) read.push(decodeRecord(bytes));
    return read;
  };

  const send = async (bytes: Uint8Array): Promise<Served> => {
    postRequest(views, bytes);
    await Atomics.waitAsync(views.words, Word.state, State.request, 10_000).value;
    const reply =
      Atomics.load(views.words, Word.state) === State.crashed
        ? {
            ret: Atomics.load(views.words, Word.replyRet),
            outSeq: Atomics.load(views.words, Word.replyOutSeq) >>> 0,
          }
        : takeReply(views);
    return { ...reply, records: records() };
  };

  return {
    views,
    records,
    send,
    request: (ic: number, request: Request): Promise<Served> => send(encodeRequest(ic, request)),
  };
};
