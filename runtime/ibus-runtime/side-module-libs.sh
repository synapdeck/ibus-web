# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

checkSideModuleLibraries() {
  local flag name provided runtimeLibraries
  runtimeLibraries="$($PKG_CONFIG --static --libs libibus-web)"
  # A second copy of a runtime library would have independent global state.
  for flag in "$@"; do
    case "$flag" in
    # glibc's split-out parts of libc: emcc drops them from every link.
    -lm | -ldl | -lrt | -lpthread) continue ;;
    -l*) name=${flag#-l} ;;
    # An archive named by its path is linked as surely as one found by -l.
    *.a)
      name=$(basename "$flag" .a)
      name=${name#lib}
      ;;
    *) continue ;;
    esac
    for provided in $runtimeLibraries; do
      if [ "$provided" = "-l$name" ]; then
        echo "side module cannot link $flag: it takes this library from the runtime" >&2
        return 1
      fi
    done
  done
}
