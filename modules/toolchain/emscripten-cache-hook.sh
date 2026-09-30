# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

# Each build gets a private copy of the prebuilt cache. The library directory
# is made read-only, so a build that needs a variant the cache lacks fails
# with "Permission denied" instead of silently compiling libc again.
emscriptenCacheSetup() {
  export EM_CACHE="$NIX_BUILD_TOP/emscripten-cache"
  if [ ! -d "$EM_CACHE" ]; then
    cp -r --no-preserve=mode @cache@ "$EM_CACHE"
    chmod -R a-w "$EM_CACHE/sysroot/lib"
  fi
  # Emscripten writes to $HOME, which the sandbox points at a missing path.
  if [ "${HOME:-/homeless-shelter}" = /homeless-shelter ]; then
    export HOME="$NIX_BUILD_TOP"
  fi
}

emscriptenCacheSetup
