# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, pkgs, ... }:
    let
      marisa = pkgs.callPackage ./_marisa.nix { };
      wasm = config.ibusWeb.toolchain.pkgsWasm.marisa;
    in
    {
      # Upstream's tests run in the native build's check phase. They can't run
      # in the WebAssembly build, which must carry the same patches.
      checks.table-marisa =
        assert map toString wasm.patches == map toString marisa.patches;
        marisa;
    };
}
