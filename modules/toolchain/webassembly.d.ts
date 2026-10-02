// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The part of the WebAssembly API these scripts use. Node has the whole API,
// but TypeScript declares it only in its web libraries, which would also
// bring in globals Node lacks.
declare namespace WebAssembly {
  interface MemoryDescriptor {
    initial: number;
    maximum?: number;
    shared?: boolean;
  }
  class Memory {
    constructor(descriptor: MemoryDescriptor);
    readonly buffer: ArrayBuffer | SharedArrayBuffer;
  }
}
