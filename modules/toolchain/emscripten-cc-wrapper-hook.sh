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

# The value a link gives Emscripten's setting $1, empty when it gives none.
# As in emcc, the last one given wins, written -sNAME=... or -s NAME=...; a
# setting given bare, -sNAME, is 1.
emscriptenLinkSetting() {
  local arg setting value= afterS=
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
    "$1") value=1 ;;
    "$1"=*) value=${setting#"$1"=} ;;
    esac
  done
  echo "$value"
}

# The link's ENVIRONMENT setting, as a space-separated list; empty when the
# link sets none, which emcc takes for every environment. Its list may be
# bracketed and its names quoted.
emscriptenLinkEnvironment() {
  local environment
  environment=$(emscriptenLinkSetting ENVIRONMENT)
  environment=${environment//[\[\]\"\']/}
  echo "${environment//,/ }"
}

# Whether the link makes a program: not a side module, a relocatable or
# archive-like object, or a bare .wasm, none of which emcc gives JavaScript.
emscriptenLinksProgram() {
  local arg output= afterO=
  for arg in "${params[@]}"; do
    if [ -n "$afterO" ]; then
      afterO=
      output=$arg
      continue
    fi
    case "$arg" in
    -shared | -r) return 1 ;;
    -o) afterO=1 ;;
    -o*) output=${arg#-o} ;;
    esac
  done
  case "$output" in
  *.wasm | *.o | *.a | *.so | *.dylib | *.bc) return 1 ;;
  esac
  case "$(emscriptenLinkSetting SIDE_MODULE)" in
  "" | 0) return 0 ;;
  *) return 1 ;;
  esac
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

  # A program carries its WebAssembly inside its JavaScript, so it is one
  # file to install, copy and run. Ahead of the command's own arguments, a
  # link's -sSINGLE_FILE=0 still wins.
  if emscriptenLinksProgram; then
    extraBefore=(-sSINGLE_FILE "${extraBefore[@]}")
  fi
fi
