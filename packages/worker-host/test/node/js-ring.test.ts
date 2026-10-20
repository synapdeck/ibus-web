// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The host as released, on a ring far smaller than what a JavaScript module
// writes at once: the backend sleeps on the control buffer's wake word until
// the page, draining as it goes, makes room.

import {
  CreateEngine,
  encodeRequest,
  FocusIn,
  Init,
  ProcessKeyEvent,
  transportLayout,
  type DecodedRecord,
} from "@ibus-web/protocol";
import { State, Word } from "@ibus-web/protocol/transport";
import { afterAll, expect, test } from "vitest";
import { postRequest, takeReply } from "../../src/shared/control.ts";
import { page, scriptDirectory, scriptUrl, start } from "./js-host.ts";

const scripts = scriptDirectory("ibus-web-js-ring-");
afterAll(scripts.remove);

const layout = transportLayout({ ringBytes: 256 });

// Each burst is 40 short commits, then one commit whose record alone is
// larger than the ring. A key writes one; focusing schedules one far enough
// off that the host is idle when it runs.
const large = "x".repeat(600);
const burst = [...Array.from({ length: 40 }, (_, index) => String(index)), large];

const bursting = scripts.manifest(
  "bursting.mjs",
  `import script from ${JSON.stringify(scriptUrl)};\n` +
    `const burst = ${JSON.stringify(burst)};\n` +
    "const trace = { ...script.engines.trace, create: (context) => ({\n" +
    "  processKey() { for (const text of burst) context.commit(text); return true; },\n" +
    "  focusIn() { context.after(20, () => { for (const text of burst) context.commit(text); }); },\n" +
    "}) };\n" +
    "export default { ...script, engines: { ...script.engines, trace } };\n",
);

const committed = (records: readonly DecodedRecord[]) =>
  records.map(({ seq, ic, record }) => [seq, ic, record._tag === "CommitText" ? record.text.text : record._tag]);

const expected = (first: number) => burst.map((text, index) => [first + index, 1, text]);

const init = new Init({ version: 1, userDataWritable: false, settings: [], patterns: [] });

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

test("a request writing more than the ring holds is drained as the page reads, its reply after its last record", async () => {
  const { worker, control, message } = await start(bursting, layout);
  try {
    expect(message).toMatchObject({ type: "ready" });
    const host = page(control, layout);
    expect((await host.request(0, init)).ret).toBe(0);
    expect((await host.request(1, new CreateEngine({ name: "trace" }))).ret).toBe(0);

    // The page reads while the request is in flight, as it does on the
    // doorbell the host rings while it waits for room.
    const read: DecodedRecord[] = [];
    postRequest(host.views, encodeRequest(1, new ProcessKeyEvent({ keyval: 0x61, keycode: 0, state: 0 })));
    while (Atomics.load(host.views.words, Word.state) === State.request) {
      read.push(...host.records());
      await tick();
    }
    const reply = takeReply(host.views);
    read.push(...host.records());

    expect(reply).toEqual({ ret: 1, outSeq: burst.length });
    expect(committed(read)).toEqual(expected(1));

    // Nothing was left to publish after the reply.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(host.records()).toEqual([]);
  } finally {
    await worker.terminate();
  }
});

test("a timer writing more than the ring holds is drained while the host is idle", async () => {
  const { worker, control } = await start(bursting, layout);
  try {
    const host = page(control, layout);
    expect((await host.request(0, init)).ret).toBe(0);
    expect((await host.request(1, new CreateEngine({ name: "trace" }))).ret).toBe(0);
    expect(await host.request(1, new FocusIn({}))).toMatchObject({ ret: 0, outSeq: 0 });

    const read: DecodedRecord[] = [...host.records()];
    for (let waited = 0; read.length < burst.length && waited < 2000; waited += 1) {
      await tick();
      read.push(...host.records());
    }
    expect(committed(read)).toEqual(expected(1));
  } finally {
    await worker.terminate();
  }
});
