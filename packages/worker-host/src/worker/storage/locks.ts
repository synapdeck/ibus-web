// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Requesting the Web Locks a host holds.

import type { HeldLock } from "./held.ts";

const lockManager = (name: string): LockManager => {
  const locks = (globalThis.navigator as { locks?: LockManager } | undefined)?.locks;
  if (locks === undefined) throw new Error(`no Web Locks here to take ${name} with`);
  return locks;
};

// The lock once granted, or null if options.ifAvailable and it is held.
export const requestLock = (name: string, options: LockOptions): Promise<HeldLock | null> =>
  new Promise((resolve, reject) => {
    lockManager(name)
      .request(name, options, (lock) =>
        lock === null ? resolve(null) : new Promise<void>((release) => resolve({ name, release })),
      )
      .catch(reject);
  });
