// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The wake relay, failing on purpose once it has forwarded as many wakes as
// its URL's "after" says, or three. Copied beside the host as released, as
// its relay.js, it takes that host's relay's place.

import { forward, type RelayInit } from "../../src/worker/forward.ts";

const after = Number(new URL(import.meta.url).searchParams.get("after") ?? 3);
let waits = 0;

self.onmessage = ({ data }: MessageEvent<RelayInit>) => {
  self.onmessage = null;
  forward(
    data,
    () => self.postMessage("ready"),
    (words, index, value) => {
      if (waits++ >= after) throw new Error("the relay fails on purpose");
      return Atomics.wait(words, index, value);
    },
  );
};
