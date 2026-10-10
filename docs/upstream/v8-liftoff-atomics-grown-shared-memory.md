# V8: atomics trap on shared memory another thread has grown

**A note, not a new issue.** V8 tracks this as [529880019](https://issues.chromium.org/issues/529880019) and
[533026477](https://issues.chromium.org/issues/533026477), fixed on V8's main branch by two CLs:

- [8466625](https://chromium-review.googlesource.com/c/v8/v8/+/8466625), "[wasm] Atomic memory.size and dynamic bounds
  checks for shared memory" (`34241014`, `refs/heads/main@{#110162}`, merged 2026-09-29). V8 cached a shared memory's
  byte length in each instance's data and brought other threads' copies up to date through an interrupt, handled at
  their next stack check; bounds checks on a shared memory now read `BackingStore::byte_length_` itself.
- [8480479](https://chromium-review.googlesource.com/c/v8/v8/+/8480479), "[wasm] Use seq_cst ordering when growing Wasm
  memory" (`db4f3c2a`, `refs/heads/main@{#110205}`, merged 2026-09-30): growth updates that length with `seq_cst`
  ordering.

Checked 2026-10-02: Gerrit still lists both Change-Ids on `main` only (no cherry-pick to `refs/branch-heads/15.6`, whose
newest CLs are 15.6.75.x merges) and no revert; no nodejs/node pull request names either CL. Both issues are public
(they load without signing in). Nothing to post: V8 has the bug and the fix; the comment below stays optional.

## Where the fix lands

- **Chrome 157.** `include/v8-version.h` reads 15.7.0 at both commits, so they landed after V8's 15.6 branch (Chrome
  156, in beta) was cut, and Gerrit lists no cherry-pick of either Change-Id to a branch. V8 15.7 ships in Chrome 157,
  whose schedule (Chromium's release schedule, chromiumdash) is: branch 2026-10-12, beta 2026-10-14, early stable
  2026-10-21, stable 2026-11-03. Confidence: high.
- **No Node release line.** Node 24 ships V8 13.6, Node 25 V8 14.1, Node 26 and Node's main branch V8 14.6 (each line's
  `deps/v8/include/v8-version.h`). A backport would be a cherry-pick into `deps/v8`, which leaves that version as it is,
  so the version alone doesn't rule one out: the commits touching `deps/v8` since 2026-09-28 on `main`, `v24.x`,
  `v25.x`, `v26.x` and their `-staging` branches (GitHub's commit listing, 2026-10-01) are three cherry-picks of other
  V8 commits, and no pull request on nodejs/node names either commit or the first CL's subject. The first Node major on
  V8 15.7 or later would carry the fix; which one that is isn't known yet. Confidence: high that no line has it today,
  resting mostly on the CLs being two and three days old; a backport could land at any time.

## Our reproduction

No Emscripten: a hand-assembled module over an imported shared memory, run under Node or Bun and in a browser page (the
M0 memory spike's `growrace`, since removed from the tree; posting it means writing it out again from this description).
The page, or Node's main thread, grows the memory a page at a time, 8192 times, and after each growth `Atomics.store`s
at address 0 the address of the last word of the new page. Sixteen reader Workers spin in WebAssembly on
`i32.atomic.load` of address 0 and increment each new address they see. A reader touches an address only after a
sequentially consistent load has read the store that follows its growth, so no reader should trap. Each race compiles
the module afresh (a custom section holds a nonce), so no race runs code an earlier one tiered up.

A reader increments:

- _plain_: with `i32.load` then `i32.store`;
- _atomic_: with `i32.atomic.rmw.add`, inline in the loop;
- _atomic-callee_: the same, in a WebAssembly function the loop calls;
- _atomic-after-js_: the same inline, after calling an empty imported JavaScript function;
- _never grown_ (control): _atomic_, on a memory made at its full size.

The call in the last two puts a stack check, where V8 handles interrupts, between the load that sees an address and the
access to it.

Races in which a reader trapped, of 20 races per cell, 2026-10-01:

| Engine                                       | plain | atomic              | atomic-callee | atomic-after-js | never grown |
| -------------------------------------------- | ----- | ------------------- | ------------- | --------------- | ----------- |
| Node 24.19.0 (V8 13.6.233.17), default flags | 0     | **20** (42 readers) | 0             | 0               | 0           |
| Node, `--liftoff --no-wasm-tier-up`          | 0     | **20** (34 readers) | 0             | 0               | 0           |
| Node, `--no-liftoff`                         | 0     | 0                   | 0             | 0               | 0           |
| Chromium 149 (Playwright's headless shell)   | 0     | **20** (29 readers) | 0             | 0               | 0           |
| Firefox 151                                  | 0     | 0                   | 0             | 0               | 0           |
| Bun 1.3.13 (JavaScriptCore)                  | 0     | 0                   | 0             | 0               | 0           |

Every trap is `RuntimeError: memory access out of bounds`. It takes V8, an atomic access (plain ones rely on the guard
region, not the cached length), Liftoff code, and no stack check between seeing the address and touching it: the cached
length and interrupt that 8466625 removes. In the control the grower publishes faster than readers follow (about a tenth
as many increments), but there no access can be out of bounds at all.

The same program in C through Emscripten's pthreads (8 readers, 8192 pages, `-sALLOW_MEMORY_GROWTH`) trapped in 5 of 5
runs under Node. Through Emscripten's runtime it shows as rare thread deaths, all under Node, at whatever atomic access
a thread makes to memory grown since its last stack check: in GLib's `1bit-emufutex` test, 32 copies at once, 15 of 300
runs trapped (0 of 300 with a fixed memory), and a build with function names put all 9 traps of another 300 runs at one
`i32.atomic.rmw.add`, a libc++ `shared_ptr` reference count in WasmFS's `OpenFileState::create`, under the `open()` of
`/dev/urandom` that `g_rand_new()` makes at each thread's start; in ibus-web's GLib-free allocation workload, 100
threads, 3 of 300 runs trapped (0 of 300 fixed), at the workload's own atomic increment of a word in a freshly allocated
block. ibus-web gives each Worker a fixed memory instead.

## Worth a comment on the issue?

A short one at most, and only if the issues are public. The CLs already describe the mechanism and come with tests. What
ours would add: a standalone, Emscripten-free test case of about a hundred lines that traps in every race under Node 24
and Chromium 149, with the Liftoff-only and no-stack-check conditions; and that every Node line (24, 25, 26) still has
the bug, which matters to a backport request to Node more than to V8. Whether to post, here or to Node, is the user's
call; nothing has been posted.
