// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The wake relay's Worker, which the host starts by URL. Its one message is
// a RelayInit; it says "ready" once it is forwarding.

import { forward, type RelayInit } from "./forward.ts";

self.onmessage = ({ data }: MessageEvent<RelayInit>) => {
  self.onmessage = null;
  forward(data, () => self.postMessage("ready"));
};
