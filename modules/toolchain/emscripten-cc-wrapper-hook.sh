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

# The link's ENVIRONMENT setting, as a space-separated list; empty when the
# link sets none, which emcc takes for every environment. As in emcc, the
# last one given wins, written -sENVIRONMENT=... or -s ENVIRONMENT=..., and
# its list may be bracketed and its names quoted.
emscriptenLinkEnvironment() {
  local arg setting environment= afterS=
  for arg in "${extraBefore[@]}" "${params[@]}" "${extraAfter[@]}"; do
    if [ -n "$afterS" ]; then
      afterS=
      setting=$arg
    elif [ "$arg" = -s ]; then
      afterS=1
      continue
    else
      setting=${arg#-s}
      [ "$setting" != "$arg" ] || continue
    fi
    case "$setting" in
    ENVIRONMENT=*) environment=${setting#ENVIRONMENT=} ;;
    esac
  done
  environment=${environment//[\[\]\"\']/}
  echo "${environment//,/ }"
}

# Every link targets the project's oldest browsers and Node, which decide the
# Wasm features and JavaScript Emscripten emits. Compiles are left alone:
# emcc warns that a link setting is ignored there. Ahead of the command's own
# arguments, a package's own minimum still wins. A link that can't run under
# Node leaves out Node's minimum, and one that can't run in a browser the
# browsers', since emcc would warn about and ignore them.
if [ "$dontLink" != 1 ]; then
  read -ra emscriptenMinimumVersionFlags <@minimumVersionFlags@
  read -ra emscriptenEnvironment <<<"$(emscriptenLinkEnvironment)"
  if [ "${#emscriptenEnvironment[@]}" = 0 ]; then
    emscriptenForNode=1
    emscriptenForBrowsers=1
  else
    emscriptenForNode=
    emscriptenForBrowsers=
    for emscriptenName in "${emscriptenEnvironment[@]}"; do
      case "$emscriptenName" in
      node) emscriptenForNode=1 ;;
      web | worker | webview) emscriptenForBrowsers=1 ;;
      esac
    done
  fi
  emscriptenMinimums=()
  for emscriptenFlag in "${emscriptenMinimumVersionFlags[@]}"; do
    case "$emscriptenFlag" in
    -sMIN_NODE_VERSION=*) [ -z "$emscriptenForNode" ] || emscriptenMinimums+=("$emscriptenFlag") ;;
    -sMIN_*_VERSION=*) [ -z "$emscriptenForBrowsers" ] || emscriptenMinimums+=("$emscriptenFlag") ;;
    *) emscriptenMinimums+=("$emscriptenFlag") ;;
    esac
  done
  extraBefore=("${emscriptenMinimums[@]}" "${extraBefore[@]}")
fi
