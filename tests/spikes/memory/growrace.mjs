// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// A shared WebAssembly memory grown on one thread while others spin in
// WebAssembly reading the word at address 0. The grower stores there, after
// each growth, the address of the last word of the page it added; each reader
// that sees a new address increments the word there. A reader only ever
// touches memory it has seen grown, through a sequentially consistent load
// that comes after the growth, so none should trap.
//
// How a reader increments, by access:
//  - "plain": i32.load, then i32.store;
//  - "atomic": i32.atomic.rmw.add, in the loop itself;
//  - "atomic-callee": the same in a WebAssembly function the loop calls;
//  - "atomic-after-js": the same in the loop, after calling an empty
//    JavaScript function.
// The last two give the reader's thread a function entry, where an engine
// may handle requests from other threads, between the load that sees the
// address and the access.
//
// With grow false, the memory starts at its full size and the grower only
// publishes the same addresses: a control.

const PAGE = 65536;

export const accesses = ["plain", "atomic", "atomic-callee", "atomic-after-js"];

// (import "env" "memory" (memory 1 65536 shared))
// (import "env" "poke" (func $poke))
// (func (export "spin") (param $access i32) (result i32)
//   (local $last i32) (local $address i32) (local $count i32)
//   (loop
//     (local.set $address (i32.atomic.load (i32.const 0)))
//     (if (i32.eq (local.get $address) (i32.const -1))
//       (then (return (local.get $count))))
//     (if (i32.ne (local.get $address) (local.get $last))
//       (then
//         (if (i32.eqz (local.get $access))
//           (then (i32.store (local.get $address)
//                   (i32.add (i32.load (local.get $address)) (i32.const 1))))
//         (else (if (i32.eq (local.get $access) (i32.const 1))
//           (then (drop (i32.atomic.rmw.add (local.get $address) (i32.const 1))))
//         (else (if (i32.eq (local.get $access) (i32.const 2))
//           (then (call $increment (local.get $address)))
//         (else
//           (call $poke)
//           (drop (i32.atomic.rmw.add (local.get $address) (i32.const 1))))))))
//         (local.set $last (local.get $address))
//         (local.set $count (i32.add (local.get $count) (i32.const 1)))))
//     (br 0))
//   (unreachable))
// (func $increment (param $address i32)
//   (drop (i32.atomic.rmw.add (local.get $address) (i32.const 1))))
const section = (id, bytes) => [id, bytes.length, ...bytes];
const name = (text) => [text.length, ...new TextEncoder().encode(text)];
const plain = [0x20, 2, 0x20, 2, 0x28, 2, 0, 0x41, 1, 0x6a, 0x36, 2, 0];
const atomic = [0x20, 2, 0x41, 1, 0xfe, 0x1e, 2, 0, 0x1a];
const spin = [
  1, 3, 0x7f, // three i32 locals
  0x03, 0x40, // loop
  0x41, 0, 0xfe, 0x10, 2, 0, 0x21, 2, // address = atomic.load 0
  0x20, 2, 0x41, 0x7f, 0x46, 0x04, 0x40, 0x20, 3, 0x0f, 0x0b, // -1: return
  0x20, 2, 0x20, 1, 0x47, 0x04, 0x40, // if address != last
  0x20, 0, 0x45, 0x04, 0x40, ...plain, // access 0
  0x05, 0x20, 0, 0x41, 1, 0x46, 0x04, 0x40, ...atomic, // access 1
  0x05, 0x20, 0, 0x41, 2, 0x46, 0x04, 0x40, 0x20, 2, 0x10, 2, // 2: call
  0x05, 0x10, 0, ...atomic, // 3: poke, then the access
  0x0b, 0x0b, 0x0b,
  0x20, 2, 0x21, 1, // last = address
  0x20, 3, 0x41, 1, 0x6a, 0x21, 3, // count++
  0x0b, // end if
  0x0c, 0, // br 0
  0x0b, // end loop
  0x00, // unreachable
  0x0b,
];
const increment = [0, 0x20, 0, 0x41, 1, 0xfe, 0x1e, 2, 0, 0x1a, 0x0b];
export const moduleBytes = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  ...section(1, [3, 0x60, 1, 0x7f, 1, 0x7f, 0x60, 0, 0, 0x60, 1, 0x7f, 0]),
  ...section(2, [
    2,
    ...name("env"), ...name("memory"), 0x02, 0x03, 0x01, 0x80, 0x80, 0x04,
    ...name("env"), ...name("poke"), 0x00, 1,
  ]),
  ...section(3, [2, 0, 2]),
  ...section(7, [1, ...name("spin"), 0x00, 1]),
  ...section(10, [2, spin.length, ...spin, increment.length, ...increment]),
]);

// startWorker() returns { post(message), onMessage(listener), terminate() }
// for a Worker running growrace-worker.mjs. Resolves to how many pages were
// published, the readers' traps (their messages) and their increments.
export const race = async ({
  readers,
  pages,
  access,
  grow = true,
  startWorker,
}) => {
  const memory = new WebAssembly.Memory({
    initial: grow ? 1 : 1 + pages,
    maximum: 1 + pages,
    shared: true,
  });
  // A custom section of its own makes each race's module new to the engine,
  // so no race reuses code an earlier one had tiered up.
  const nonce = new TextEncoder().encode(String(Math.random()));
  const module = await WebAssembly.compile(
    new Uint8Array([...moduleBytes, 0, 2 + nonce.length, 1, 0x6e, ...nonce]),
  );
  const mode = accesses.indexOf(access);
  if (mode < 0) throw new Error(`no access ${access}`);
  const workers = Array.from({ length: readers }, startWorker);
  const ready = [];
  const done = workers.map(
    (worker) =>
      new Promise((resolve) => {
        let started;
        ready.push(new Promise((resolveReady) => (started = resolveReady)));
        worker.onMessage((message) =>
          message.type === "ready" ? started() : resolve(message),
        );
      }),
  );
  for (const worker of workers) worker.post({ memory, module, mode });
  await Promise.all(ready);
  // Lets the readers get into their loops.
  await new Promise((resolve) => setTimeout(resolve, 50));
  let published = 0;
  for (; published < pages; published++) {
    // grow(0) keeps the control's pace near a growing race's.
    const old = grow ? memory.grow(1) : (memory.grow(0), 1 + published);
    Atomics.store(new Int32Array(memory.buffer), 0, (old + 1) * PAGE - 4);
  }
  Atomics.store(new Int32Array(memory.buffer), 0, -1);
  const outcomes = await Promise.all(done);
  for (const worker of workers) worker.terminate();
  return {
    published,
    traps: outcomes
      .filter(({ type }) => type === "trap")
      .map(({ message }) => message),
    increments: outcomes.reduce((sum, { count }) => sum + (count ?? 0), 0),
  };
};

// Every access with the memory growing, then the atomic one on a memory
// that never grows, runs races each. report(line) gets a line per race;
// resolves to a row per configuration: its races, the races in which a
// reader trapped, the readers that did, and the first trap's message.
export const matrix = async ({ readers, pages, runs, startWorker, report }) => {
  const configurations = [
    ...accesses.map((access) => ({ access, grow: true })),
    { access: "atomic", grow: false },
  ];
  const rows = [];
  for (const { access, grow } of configurations) {
    const row = {
      access,
      grow,
      runs: 0,
      trapped: 0,
      readersTrapped: 0,
      trap: null,
    };
    for (let run = 1; run <= runs; run++) {
      const { traps, increments } = await race({
        readers,
        pages,
        access,
        grow,
        startWorker,
      });
      row.runs++;
      if (traps.length > 0) row.trapped++;
      row.readersTrapped += traps.length;
      row.trap ??= traps[0] ?? null;
      report(
        `${access}${grow ? "" : ", never grown"} race ${run}: ${increments} increments, ` +
          `${traps.length} of ${readers} readers trapped` +
          (traps.length > 0 ? ` (${traps[0]})` : ""),
      );
    }
    rows.push(row);
  }
  return rows;
};
