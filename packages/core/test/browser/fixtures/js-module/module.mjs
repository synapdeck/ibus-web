// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

export default {
  ibusWebModule: 1,
  name: "page-js",
  version: "1",
  license: "MIT",
  engines: {
    one: {
      descriptor: { displayName: "One", languages: ["en"], keyboard: { layout: "us", passThrough: [] } },
      create: () => ({}),
    },
    // Never answers a key, sleeping on a word nothing writes.
    stall: {
      descriptor: { displayName: "Stall", languages: ["en"], keyboard: { layout: "us", passThrough: [] } },
      create: () => ({
        processKey() {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
          return true;
        },
      }),
    },
  },
};
