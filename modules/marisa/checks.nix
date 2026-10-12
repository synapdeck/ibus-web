# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb) marisa;
      wasm = config.ibusWeb.toolchain.pkgsWasm.marisa;
    in
    {
      # Upstream's tests run in the native build's check phase. They can't run
      # in the WebAssembly build, which must carry the same patches.
      checks.marisa-tests =
        assert map toString wasm.patches == map toString marisa.patches;
        marisa;
    };
}
