// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The part of the WebAssembly API the test file uses. Node has the whole
// API, but TypeScript declares it only in its web libraries, which would also
// bring in globals Node lacks.
declare namespace WebAssembly {
  interface MemoryDescriptor {
    initial: number;
    maximum?: number;
    shared?: boolean;
  }
  class Memory {
    constructor(descriptor: MemoryDescriptor);
  }
  type ImportExportKind = "function" | "global" | "memory" | "table" | "tag";
  interface ModuleImportDescriptor {
    kind: ImportExportKind;
    module: string;
    name: string;
  }
  class Module {
    static imports(module: Module): ModuleImportDescriptor[];
  }
  class Instance {}
  class LinkError extends Error {}
  type ImportValue = Memory | ((...args: never[]) => unknown);
  function compile(bytes: Uint8Array): Promise<Module>;
  function instantiate(module: Module, imports: Record<string, Record<string, ImportValue>>): Promise<Instance>;
}
