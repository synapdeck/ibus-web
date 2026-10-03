# Node: Web Locks grant one exclusive lock to two worker_threads at once

**Draft: new issue, for the user to file.** Not posted. We found no existing
report: on 2026-10-02, `gh search issues --repo nodejs/node` for "web locks",
"navigator.locks", "LockManager", "locks worker_threads", "locks.request",
"node_locks", "exclusive lock worker", "lock granted worker_threads", "locks
race" and "steal lock" (and `gh search prs` for "web locks", "LockManager",
"locks") turned up only #59142 (a flaky WPT test, closed), #62644 ("locks.request
live lock", closed) and its fix #65520 ("src: fix live lock between
environments with blocked requests", merged 2026-09-02, in 26.9.0), which
changes which environments `ProcessQueue()` wakes, not which requests it
grants. Rerun the same day, the double grant is still there on Node 26.10.0,
which has #65520 (table below).

Node's `navigator.locks` is shared by every thread of a process. When two
`worker_threads` request the same exclusive lock at the same moment, both
are sometimes granted it, and each callback runs while the other still holds
the lock. This happens with `ifAvailable: true` and with ordinary queued
requests alike. Nothing in ibus-web works around it: Node hosts are only used
in tests, and tests don't start them concurrently on shared storage.

## Issue title

Web Locks: an exclusive lock is sometimes granted to two worker_threads at once

## Issue body

---

**Version:** v26.10.0, v24.21.0 and v24.20.0, x86_64 Linux.

**Platform:** Linux 6.18 x86_64.

**Subsystem:** Web Locks (`navigator.locks`), worker_threads.

### What steps will reproduce the bug?

Each round starts two Workers. They spin on a shared counter so that both
request the same lock name at once. Each Worker reports whether its request
was granted, and a granted Worker holds the lock forever. Exactly one should
ever be granted.

`ifavailable.mjs`:

```js
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
if (isMainThread) {
  let doubles = 0;
  for (let round = 0; round < 300; round++) {
    const name = `l${round}`;
    const sab = new SharedArrayBuffer(8);
    const ws = [0, 1].map(() => new Worker(new URL(import.meta.url), { workerData: { name, sab } }));
    const got = await Promise.all(ws.map((w) => new Promise((r) => w.once("message", r))));
    if (got.filter(Boolean).length === 2) doubles++;
    await Promise.all(ws.map((w) => w.terminate()));
  }
  console.log("double grants:", doubles, "of 300");
} else {
  const { name, sab } = workerData;
  const a = new Int32Array(sab);
  Atomics.add(a, 0, 1);
  while (Atomics.load(a, 0) < 2);
  navigator.locks.request(name, { ifAvailable: true }, (lock) => {
    parentPort.postMessage(lock !== null);
    return lock === null ? undefined : new Promise(() => {});
  });
}
```

`queued.mjs` is the same, except that the Worker's request is queued rather
than `ifAvailable`. The request that loses gives up after 2 s:

```js
const c = new AbortController();
setTimeout(() => c.abort(), 2000);
navigator.locks
  .request(name, { signal: c.signal }, () => {
    parentPort.postMessage(true);
    return new Promise(() => {});
  })
  .catch(() => parentPort.postMessage(false));
```

```
$ node ifavailable.mjs
double grants: 12 of 300
$ node queued.mjs
double grants: 8 of 300
```

### How often does it reproduce? Is there a required condition?

It reproduces in a few percent of rounds. Each figure is double grants in
300 rounds, from a separate run:

| Node    | Run                                 | Double grants |
| ------- | ----------------------------------- | ------------- |
| 24.21.0 | `ifavailable.mjs`                   | 12            |
| 24.21.0 | `queued.mjs`                        | 8             |
| 24.21.0 | independent runs of the same race   | 9, 4          |
| 24.20.0 | an independent run of the same race | 11            |
| 26.10.0 | `ifavailable.mjs`                   | 9             |
| 26.10.0 | `queued.mjs`                        | 11            |

Both requests have to come from different threads at nearly the same time.

### What is the expected behavior? Why is that the expected behavior?

`double grants: 0 of 300`. An exclusive lock is held by at most one request
at a time: Web Locks API, "request a lock" and "lock is grantable", for
`"exclusive"` mode. Under `ifAvailable` the second request should be granted
`null`. A queued request should wait until the holder lets go.

### What do you see instead?

Both Workers' callbacks run with a lock, and both hold it at the same time.

### Additional information

We found it in a test suite where several Worker hosts share a directory and
use an exclusive Web Lock to decide which one writes. Browsers (Chromium,
Firefox) never showed it in the same suite.

---
