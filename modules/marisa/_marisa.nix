# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  lib,
  stdenv,
  fetchpatch,
  marisa,
}:
marisa.overrideAttrs (old: {
  patches = (old.patches or [ ]) ++ [
    # 0.3.1 reads uninitialized units while packing a FlatVector.
    (fetchpatch {
      name = "marisa-flat-vector-build.patch";
      url = "https://github.com/s-yata/marisa-trie/commit/e31c7ed028f01c844e920cdfa56b438c59d5987a.patch";
      hash = "sha256-PM30tfoXHOYZhu2Uh4C83mNDLe848thInQDOZxb0lx4=";
    })
  ];

  # No instructions tuned to the build machine, which a browser's may lack.
  # The engine links the library alone.
  cmakeFlags = (old.cmakeFlags or [ ]) ++ [
    "-DENABLE_NATIVE_CODE=OFF"
    "-DENABLE_TOOLS=OFF"
  ];

  # Upstream's tests, wherever the build can run them.
  doCheck = stdenv.buildPlatform.canExecute stdenv.hostPlatform;
  checkPhase = ''
    runHook preCheck
    ctest --output-on-failure --no-tests=error
    runHook postCheck
  '';

  # COPYING.md offers BSD-2-Clause or LGPL-2.1-or-later; the engine takes
  # BSD-2-Clause.
  meta = old.meta // {
    license = lib.licenses.bsd2;
  };
})
