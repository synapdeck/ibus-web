# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

# Recipes pass flags meant for clang and lld, which this compiler presents
# itself as; emcc and wasm-ld reject these, so they are dropped here rather
# than in each recipe.
emscriptenDropUnsupported() {
  local -n args=$1
  local kept=() arg
  for arg in "${args[@]}"; do
    case "$arg" in
    -static-libgcc | -Wl,--undefined-version | --undefined-version) ;;
    *) kept+=("$arg") ;;
    esac
  done
  args=("${kept[@]}")
}

emscriptenDropUnsupported params
emscriptenDropUnsupported extraBefore
emscriptenDropUnsupported extraAfter
