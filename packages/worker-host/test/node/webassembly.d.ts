// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The part of the WebAssembly API the tests under Node use. Node has the
// whole API, but TypeScript declares it only in its web libraries, which
// would also bring in globals Node lacks.
declare namespace WebAssembly {
  class Module {}
  function compile(bytes: Uint8Array<ArrayBuffer>): Promise<Module>;
}
