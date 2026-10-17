// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// What the host posts of its storage as it wakes: a closed connection once,
// and changes that failed for want of space each time there are more.

import { describe, expect, test } from "vitest";
import type { HostMessage } from "../../src/shared/messages.ts";
import { storageWatcher } from "../../src/worker/storage/watch.ts";

describe("storage-watch", () => {
  const watching = () => {
    const storage = { isClosed: false, failures: 0 };
    const posted: HostMessage[] = [];
    const watch = storageWatcher({ closed: () => storage.isClosed, quotaFailures: () => storage.failures }, (message) =>
      posted.push(message),
    );
    return { storage, posted, watch };
  };

  test("a quota failure is posted once for each wake that finds more of them", () => {
    const { storage, posted, watch } = watching();
    watch();
    expect(posted).toEqual([]);

    storage.failures = 1;
    watch();
    watch();
    storage.failures = 3;
    watch();
    expect(posted).toEqual([
      {
        type: "storage",
        state: "quota",
        message: "1 change to the engine's storage failed for want of space (ENOSPC)",
      },
      {
        type: "storage",
        state: "quota",
        message: "2 changes to the engine's storage failed for want of space (ENOSPC)",
      },
    ]);
  });

  test("a closed connection is posted once, beside quota failures", () => {
    const { storage, posted, watch } = watching();
    storage.isClosed = true;
    storage.failures = 1;
    watch();
    watch();
    expect(posted.map((message) => message.type === "storage" && message.state)).toEqual(["closed", "quota"]);
  });
});
