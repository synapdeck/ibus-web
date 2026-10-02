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

# Every link targets the project's oldest browsers and Node, which decide the
# Wasm features and JavaScript Emscripten emits. Compiles are left alone:
# emcc warns that a link setting is ignored there. Ahead of the command's own
# arguments, a package's own minimum still wins.
if [ "$dontLink" != 1 ]; then
  read -ra emscriptenMinimumVersionFlags <@minimumVersionFlags@
  extraBefore=("${emscriptenMinimumVersionFlags[@]}" "${extraBefore[@]}")
fi
