// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// What the host tells the page of its storage as it runs, which it checks
// each time it wakes: nothing it mounted calls back.

import type { HostMessage } from "../../shared/messages.ts";

export interface WatchedStorage {
  closed(): boolean;
  quotaFailures(): number;
}

// Checks the storage, posting "closed" the first time a connection has
// closed and "quota" each time more changes have failed for want of space
// than when it last looked.
export const storageWatcher = (storage: WatchedStorage, post: (message: HostMessage) => void): (() => void) => {
  let closedReported = false;
  let quotaSeen = 0;
  return () => {
    if (!closedReported && storage.closed()) {
      closedReported = true;
      post({
        type: "storage",
        state: "closed",
        message: "the IndexedDB connection closed; the engine's storage fails with EIO",
      });
    }

    const quota = storage.quotaFailures();
    if (quota > quotaSeen) {
      const failed = quota - quotaSeen;
      quotaSeen = quota;
      post({
        type: "storage",
        state: "quota",
        message: `${failed} ${failed === 1 ? "change" : "changes"} to the engine's storage failed for want of space (ENOSPC)`,
      });
    }
  };
};
