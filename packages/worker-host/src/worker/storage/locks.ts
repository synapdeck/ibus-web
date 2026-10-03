// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The Web Locks a host holds, and how it lets go of them.

// A Web Lock the host holds until it calls release().
export interface HeldLock {
  readonly name: string;
  release(): void;
}

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

// The locks this host holds. A host whose start fails, or whose runtime
// stops after it, stays alive to say why, so it lets go of them all, rather
// than keep other hosts from installing, collecting or writing the engine's
// user data.
//
// Its runtime, and any engine thread already started, can still write
// through the read-write user backend, and a host that became writer then
// would sweep beside it; so the writer lock goes only once that backend is
// sealed. A runtime that can't be called to seal it keeps the writer lock
// until the Worker, and every thread of the runtime with it, is gone.
export class Held {
  #locks = new Set<HeldLock>();
  #writer: HeldLock | null = null;
  // The read-write user backend's seal, until it has run.
  #seal: (() => void) | null = null;

  add(lock: HeldLock): HeldLock {
    this.#locks.add(lock);
    return lock;
  }

  addWriter(lock: HeldLock): void {
    this.#writer = this.add(lock);
  }

  sealWith(seal: () => void): void {
    this.#seal = seal;
  }

  release(lock: HeldLock): void {
    this.#locks.delete(lock);
    lock.release();
  }

  // Seals the read-write user backend, if there is one; throws what the seal
  // throws, leaving it unsealed.
  seal(): void {
    const seal = this.#seal;
    if (seal === null) return;
    seal();
    this.#seal = null;
  }

  // Lets go of every lock, but of the writer lock only once nothing can
  // write through this host's user backend.
  releaseAll(): void {
    for (const lock of this.#locks) if (lock !== this.#writer || this.#seal === null) lock.release();
    this.#locks.clear();
    this.#writer = null;
  }
}
