// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The memory's size comes from the command line, as its first argument in
// MiB. Pthreads are handed the main thread's memory instead.
if (!ENVIRONMENT_IS_PTHREAD) {
  const mib = Number(process.argv[2]);
  Module.INITIAL_MEMORY = mib * 1024 * 1024;
}
