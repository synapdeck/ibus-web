// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The part of the WebAssembly API the harness and its tests use. Node has
// the whole API, but TypeScript declares it only in its web libraries, which
// would also bring in globals Node lacks.
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
  type ImportExportKind = "function" | "global" | "memory" | "table" | "tag";
  interface ModuleImportDescriptor {
    kind: ImportExportKind;
    module: string;
    name: string;
  }
  interface ModuleExportDescriptor {
    kind: ImportExportKind;
    name: string;
  }
  class Module {
    static imports(module: Module): ModuleImportDescriptor[];
    static exports(module: Module): ModuleExportDescriptor[];
  }
  type ImportValue = Memory | ((...args: never[]) => unknown);
  type Imports = Record<string, Record<string, ImportValue>>;
  class Instance {
    constructor(module: Module, imports?: Imports);
  }
  class LinkError extends Error {}
  class RuntimeError extends Error {}
  function compile(bytes: Uint8Array): Promise<Module>;
}
