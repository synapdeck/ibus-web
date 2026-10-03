# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

checkSideModuleLibraries() {
  local flag provided runtimeLibraries
  runtimeLibraries="$($PKG_CONFIG --static --libs libibus-web)"
  # A second copy of a runtime library would have independent global state.
  for flag in "$@"; do
    case "$flag" in -l*) ;; *) continue ;; esac
    for provided in $runtimeLibraries; do
      if [ "$flag" = "$provided" ]; then
        echo "side module cannot link $flag: it takes this library from the runtime" >&2
        return 1
      fi
    done
  done
}
