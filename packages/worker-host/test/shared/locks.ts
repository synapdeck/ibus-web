// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The Web Locks hosts hold, as the page sees them: a page and its Workers
// share an origin's locks, and under Node every thread of the process
// shares them.

// How long a page waits for a terminated host's lock before it takes it
// that another host holds it.
export const LOCK_RELEASE_LIMIT_MS = 10_000;

// What the tests use of an environment's navigator.locks.
export interface WebLocks {
  request<T>(
    name: string,
    options: { ifAvailable?: boolean; signal?: never },
    callback: (lock: unknown) => T,
  ): Promise<T>;
}

export interface Locks {
  // Whether no one holds the lock or waits for it: a request for it,
  // exclusive, is granted at once, and let go.
  free(name: string): Promise<boolean>;
  // Settles once the lock is free, which a queued request is granted as soon
  // as it is, and let go of at once, with true; or with false once limitMs
  // has passed.
  released(name: string, limitMs?: number): Promise<boolean>;
}

// timeout: AbortSignal.timeout(), which aborts with a TimeoutError.
export const locksFrom = (locks: WebLocks, timeout: (ms: number) => never): Locks => ({
  free: (name) => locks.request(name, { ifAvailable: true }, (lock) => lock !== null),
  released: (name, limitMs = LOCK_RELEASE_LIMIT_MS) =>
    locks
      .request(name, { signal: timeout(limitMs) }, () => true)
      .catch((error: unknown) => {
        if ((error as { name?: unknown } | null)?.name === "TimeoutError") return false;
        throw error;
      }),
});
