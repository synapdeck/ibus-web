#!/usr/bin/env bash
# Playwright launches this as the browser's executable, so strace follows the
# browser and every process it starts, and nothing else. Playwright talks to
# the browser over pipes it passes as file descriptors, which strace keeps.
#
#   IDB_SYNC_BROWSER  the browser's real executable
#   IDB_SYNC_TRACE    where strace writes its trace
#   IDB_SYNC_STRACE   strace (default: strace on PATH)
set -euo pipefail
exec "${IDB_SYNC_STRACE:-strace}" -f -ttt \
  -e trace=fsync,fdatasync,sync_file_range,syncfs \
  -o "$IDB_SYNC_TRACE" -- "$IDB_SYNC_BROWSER" "$@"
