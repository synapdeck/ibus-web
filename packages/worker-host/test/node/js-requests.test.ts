// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The host as released, serving the fixture script's trace engine: every
// request kind, the records each writes and the reply that names them, a
// CreateEngine that fails, a fault and a shutdown.

import {
  CandidateClicked,
  CreateEngine,
  CursorDown,
  CursorUp,
  DestroyEngine,
  Disable,
  Enable,
  FocusIn,
  FocusOut,
  IBusAttrList,
  IBusText,
  Init,
  PageDown,
  PageUp,
  Persist,
  ProcessKeyEvent,
  PropertyActivate,
  Reset,
  SetCapabilities,
  SetContentType,
  SetCursorLocation,
  SettingChanged,
  SetSurroundingText,
  Shutdown,
  stringVariant,
  type Request,
} from "@ibus-web/protocol";
import { afterAll, expect, test } from "vitest";
import { manifest, next, page, scriptDirectory, scriptUrl, start, type Served } from "./js-host.ts";

const scripts = scriptDirectory("ibus-web-js-requests-");
afterAll(scripts.remove);

// Emscripten's errno values.
const errno = {
  EALREADY: 7,
  EBADMSG: 9,
  ECANCELED: 11,
  EEXIST: 20,
  EINVAL: 28,
  EIO: 29,
  ENOENT: 44,
  ENOSYS: 52,
  ENOTCONN: 53,
  ESRCH: 71,
  ESHUTDOWN: 140,
};

const RELEASE = 1 << 30;

// Declares the pick engine's settings, which the trace engine's session
// hears nothing of.
const init = new Init({
  version: 1,
  userDataWritable: false,
  settings: [{ schemaId: "org.example.jsfixture.pick", path: "/org/example/jsfixture/pick/", values: {} }],
  patterns: [],
});

const key = (character: string, state = 0) =>
  new ProcessKeyEvent({ keyval: character.codePointAt(0)!, keycode: 0, state });

const plain = (text: string) => ({ text, attrs: { attributes: [] } });
const underlined = (text: string) => ({
  text,
  attrs: { attributes: [{ type: 1, value: 1, startIndex: 0, endIndex: [...text].length }] },
});

const surrounding = (text: string) =>
  IBusText.make({ attachments: {}, text, attrs: IBusAttrList.make({ attachments: {}, attributes: [] }) });

const log = (message: string, level = 128) => ({ _tag: "Log", level, domain: "js-fixture", message });
const reported = (name: string, ...args: unknown[]) =>
  log(`${name}(${args.map((arg) => JSON.stringify(arg)).join(", ")})`);
const keyReported = (keyval: number, state = 0) =>
  reported("processKey", keyval, 0, state, keyval < 0x100 ? String.fromCodePoint(keyval) : "");

const property = (fields: object) => ({
  icon: "",
  tooltip: plain(""),
  sensitive: true,
  visible: true,
  state: 0,
  subProps: { properties: [] },
  symbol: plain(""),
  ...fields,
});

// A request on ic, the reply it should get, and the records it should write
// on ic, in order.
type Step = readonly [Request | Uint8Array, number, readonly object[]];

// A header and payload of raw bytes, for requests the codec won't encode.
const framed = (kind: number, flags: number, payload: readonly number[]): Uint8Array => {
  const bytes = new Uint8Array(8 + payload.length);
  const header = new DataView(bytes.buffer);
  header.setUint16(0, kind, true);
  header.setUint16(2, flags, true);
  header.setUint32(4, 1, true);
  bytes.set(payload, 8);
  return bytes;
};

const trace: readonly Step[] = [
  [new FocusIn({}), -errno.ENOTCONN, []],
  [init, 0, []],
  [init, -errno.EALREADY, []],
  [new FocusIn({}), -errno.ENOENT, []],
  [new CreateEngine({ name: "absent" }), -errno.ESRCH, []],
  [new CreateEngine({ name: "trace" }), 0, [reported("create")]],
  [new CreateEngine({ name: "trace" }), -errno.EEXIST, []],

  [key("c"), 1, [keyReported(0x63), { _tag: "CommitText", text: plain("commit") }]],
  [
    key("p"),
    1,
    [
      keyReported(0x70),
      {
        _tag: "UpdatePreeditText",
        text: {
          text: "𝄞ab",
          attrs: {
            attributes: [
              { type: 1, value: 1, startIndex: 0, endIndex: 3 },
              { type: 2, value: 0xff0000, startIndex: 1, endIndex: 2 },
            ],
          },
        },
        cursor: 1,
        visible: true,
        mode: 0,
      },
    ],
  ],
  [key("a"), 1, [keyReported(0x61), { _tag: "UpdateAuxiliaryText", text: underlined("aux"), visible: false }]],
  [
    key("l"),
    1,
    [
      keyReported(0x6c),
      {
        _tag: "UpdateLookupTable",
        table: {
          pageSize: 2,
          cursorPos: 1,
          cursorVisible: false,
          round: false,
          orientation: 2,
          candidates: [plain("one"), underlined("two")],
          labels: [],
        },
        visible: true,
      },
    ],
  ],
  [
    key("r"),
    1,
    [
      keyReported(0x72),
      {
        _tag: "RegisterProperties",
        properties: {
          properties: [
            property({
              key: "mode",
              type: 3,
              label: plain("Mode"),
              subProps: { properties: [property({ key: "mode.a", type: 2, label: plain("A"), state: 1 })] },
            }),
            property({ key: "line", type: 4, label: plain("") }),
          ],
        },
      },
    ],
  ],
  [
    key("u"),
    1,
    [
      keyReported(0x75),
      {
        _tag: "UpdateProperty",
        property: property({
          key: "mode",
          type: 3,
          label: underlined("Mode"),
          symbol: plain("M"),
          tooltip: plain("The mode"),
          icon: "mode.svg",
          sensitive: false,
          visible: false,
          state: 2,
        }),
      },
    ],
  ],
  [key("f"), 1, [keyReported(0x66), { _tag: "ForwardKeyEvent", keyval: 0x66, keycode: 41, state: 4 }]],
  [key("d"), 1, [keyReported(0x64), { _tag: "DeleteSurroundingText", offset: -2, count: 1 }]],
  [key("s"), 1, [keyReported(0x73), { _tag: "RequireSurroundingText" }]],
  [key("w"), 1, [keyReported(0x77), log("warned", 16)]],
  [key("e"), 1, [keyReported(0x65), log("erred", 8)]],
  [key("i"), 1, [keyReported(0x69), log("informed", 64)]],
  [key("z"), 0, [keyReported(0x7a)]],
  [key("c", RELEASE), 0, [keyReported(0x63, RELEASE)]],
  [
    new ProcessKeyEvent({ keyval: 0x0101d11e, keycode: 0, state: 0 }),
    0,
    [reported("processKey", 0x0101d11e, 0, 0, "𝄞")],
  ],
  [new ProcessKeyEvent({ keyval: 0xffb7, keycode: 0, state: 0 }), 0, [reported("processKey", 0xffb7, 0, 0, "7")]],
  [new ProcessKeyEvent({ keyval: 0xff1b, keycode: 0, state: 0 }), 0, [keyReported(0xff1b)]],

  [new FocusIn({}), 0, [reported("focusIn")]],
  [new FocusOut({}), 0, [reported("focusOut")]],
  [new Reset({}), 0, [reported("reset")]],
  [new Enable({}), 0, [reported("enable")]],
  [new Disable({}), 0, [reported("disable")]],
  [new SetCursorLocation({ x: -4, y: 20, width: 2, height: 16 }), 0, [reported("setCursorLocation", -4, 20, 2, 16)]],
  [new SetCapabilities({ capabilities: 9 }), 0, [reported("setCapabilities", 9)]],
  [new PageUp({}), 0, [reported("pageUp")]],
  [new PageDown({}), 0, [reported("pageDown")]],
  [new CursorUp({}), 0, [reported("cursorUp")]],
  [new CursorDown({}), 0, [reported("cursorDown")]],
  [new CandidateClicked({ index: 1, button: 3, state: 4 }), 0, [reported("candidateClicked", 1, 3, 4)]],
  [new PropertyActivate({ name: "mode.a", state: 1 }), 0, [reported("propertyActivate", "mode.a", "checked")]],
  [new PropertyActivate({ name: "mode.a", state: 2 }), 0, [reported("propertyActivate", "mode.a", "inconsistent")]],
  [new PropertyActivate({ name: "mode.a", state: 0 }), 0, [reported("propertyActivate", "mode.a", "unchecked")]],
  [new PropertyActivate({ name: "mode.a", state: 7 }), 0, [reported("propertyActivate", "mode.a", "unchecked")]],
  [
    new SetSurroundingText({ text: surrounding("a𝄞b"), cursor: 3, anchor: 1 }),
    0,
    [reported("setSurroundingText", "a𝄞b", 3, 1)],
  ],
  [new SetSurroundingText({ text: surrounding("a𝄞b"), cursor: 4, anchor: 1 }), -errno.EINVAL, []],
  [new SetContentType({ purpose: 3, hints: 8 }), 0, [reported("setContentType", 3, 8)]],
  [new SetContentType({ purpose: 3, hints: 8 }), 0, []],
  [new SetContentType({ purpose: 0, hints: 0 }), 0, [reported("setContentType", 0, 0)]],

  [new SettingChanged({ path: "/org/example/jsfixture/pick/", key: "case", value: stringVariant("upper") }), 0, []],
  [new Persist({}), 0, []],
  [framed(17, 0, []), -errno.EBADMSG, []],
  [framed(17, 1, [0]), -errno.EBADMSG, []],
  [framed(17, 0, [1, 2, 3]), -errno.EBADMSG, []],
  [framed(0xff00, 0, [0]), -errno.ENOSYS, []],
  [new Uint8Array([17, 0, 0]), -errno.EBADMSG, []],

  [new DestroyEngine({}), 0, [reported("destroy")]],
  [new FocusIn({}), -errno.ENOENT, []],
  [new CreateEngine({ name: "trace" }), 0, [reported("create")]],
  [new Shutdown({}), 0, []],
  [new FocusIn({}), -errno.ESHUTDOWN, []],
  [init, -errno.ESHUTDOWN, []],
];

// Sends each step's request on ic 1, checking its reply, its records, and
// that the reply names the last record published so far.
const run = async (send: (request: Request | Uint8Array) => Promise<Served>, steps: readonly Step[]) => {
  let seq = 0;
  for (const [request, ret, records] of steps) {
    const what = request instanceof Uint8Array ? `bytes ${[...request].join(" ")}` : JSON.stringify(request);
    const served = await send(request);
    expect(served.ret, what).toBe(ret);
    expect(served.records, what).toMatchObject(records.map((record) => ({ seq: ++seq, ic: 1, record })));
    expect(served.outSeq, what).toBe(seq);
  }
};

test("a host serves every request kind to a session of the fixture's trace engine", async () => {
  const { worker, control, message } = await start(manifest);
  try {
    expect(message).toMatchObject({ type: "ready" });

    const host = page(control);
    await run((request) => (request instanceof Uint8Array ? host.send(request) : host.request(1, request)), trace);
  } finally {
    await worker.terminate();
  }
});

test("a create that throws fails its CreateEngine with the message, and the host serves on", async () => {
  const failing = scripts.manifest(
    "failing.mjs",
    `import script from ${JSON.stringify(scriptUrl)};\n` +
      "const trace = { ...script.engines.trace, create() { throw new Error('no table'); } };\n" +
      "export default { ...script, engines: { ...script.engines, trace } };\n",
  );
  const { worker, control } = await start(failing);
  try {
    const host = page(control);
    await run(
      (request) => host.request(1, request as Request),
      [
        [init, 0, []],
        [new CreateEngine({ name: "trace" }), -errno.EIO, [{ _tag: "CreateEngineFailed", message: "no table" }]],
        [new FocusIn({}), -errno.ENOENT, []],
        [new CreateEngine({ name: "pick" }), 0, []],
      ],
    );
  } finally {
    await worker.terminate();
  }
});

test("text no record can carry is replaced in a failed create's message and a fault's, so both reach the page", async () => {
  const unframed = scripts.manifest(
    "unframed.mjs",
    `import script from ${JSON.stringify(scriptUrl)};\n` +
      "const trace = { ...script.engines.trace, create() { throw new Error('no\\0table'); } };\n" +
      "const pick = { ...script.engines.pick, create: () => ({ focusIn() { throw new Error('lone \\ud800'); } }) };\n" +
      "export default { ...script, engines: { ...script.engines, pick, trace } };\n",
  );
  const { worker, control } = await start(unframed);
  try {
    const host = page(control);
    await run(
      (request) => host.request(1, request as Request),
      [
        [init, 0, []],
        [new CreateEngine({ name: "trace" }), -errno.EIO, [{ _tag: "CreateEngineFailed", message: "no\uFFFDtable" }]],
        [new CreateEngine({ name: "pick" }), 0, []],
      ],
    );

    const crashed = next(worker);
    const served = await host.request(1, new FocusIn({}));
    expect(served).toMatchObject({ ret: -errno.ECANCELED, outSeq: 1 });

    const message = expect.stringMatching(/^engine pick threw: Error: lone \uFFFD/);
    expect(await crashed).toEqual({ type: "crashed", message });
    expect([...served.records, ...host.records()]).toMatchObject([
      { seq: 0, ic: 0, record: { _tag: "Crashed", reason: 2, message } },
    ]);
  } finally {
    await worker.terminate();
  }
});

test("a handler that throws crashes the host with FAULT once its request's records and reply are out", async () => {
  const { worker, control } = await start(manifest);
  try {
    const host = page(control);
    await run(
      (request) => host.request(1, request as Request),
      [
        [init, 0, []],
        [new CreateEngine({ name: "trace" }), 0, [reported("create")]],
      ],
    );

    const crashed = next(worker);
    const served = await host.request(1, key("!"));
    expect(served).toMatchObject({ ret: -errno.ECANCELED, outSeq: 2 });
    expect(await crashed).toEqual({
      type: "crashed",
      message: expect.stringMatching(/^engine trace threw: Error: trace fault/),
    });
    expect([...served.records, ...host.records()]).toMatchObject([
      { seq: 2, ic: 1, record: keyReported(0x21) },
      {
        seq: 0,
        ic: 0,
        record: {
          _tag: "Crashed",
          reason: 2,
          message: expect.stringMatching(/^engine trace threw: Error: trace fault/),
        },
      },
    ]);
  } finally {
    await worker.terminate();
  }
});
