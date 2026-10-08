# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.runtime.wasmfsIdb = lib.mkOption {
      type = lib.types.package;
      description = "The WasmFS IndexedDB backend: libwasmfs-idb.a and its header, with passthru.jsLibrary, the JavaScript library its links pass with --js-library, and passthru.cflags, the -I flag for the WasmFS internal headers it was compiled against.";
    };
  };
}
