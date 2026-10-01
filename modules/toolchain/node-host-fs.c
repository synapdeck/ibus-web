/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* Linked into programs that run under Node with WasmFS, so they see the
 * host's files at the paths the host gives them.
 *
 * Emscripten's own -sNODERAWFS under WasmFS roots the tree at Node's working
 * directory, so an absolute path such as /nix/store/... resolves under it.
 * Here the root is the host's /, and the working directory is Node's.
 *
 * WasmFS's Node backend traps on fsync(), and a file renamed over another
 * keeps its old host path, so reopening it fails. Files the browser keeps in
 * WasmFS's memory backend, temporary ones above all, would break here where
 * they work there, so a TMPDIR the host doesn't have is created in memory.
 * Host programs that give TMPDIR a directory of their own are unaffected. */

#include <emscripten/em_js.h>
#include <emscripten/wasmfs.h>
#include <limits.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>

EM_JS(int, host_cwd, (char *buf, int size), {
  const cwd = process.cwd();
  return lengthBytesUTF8(cwd) < size ? stringToUTF8(cwd, buf, size) : 0;
});

/* WasmFS gives its root a fixed, writable mode and checks permissions itself
 * before asking the backend, and the Node backend reports any host failure to
 * create a file as EIO. The root takes the host's mode instead, less the
 * write bits this process can't use, so creating something in a read-only /
 * fails with EACCES, as it does natively. */
EM_JS(int, host_root_mode, (void), {
  const {accessSync, constants, statSync} = require('node:fs');
  const mode = statSync('/').mode & 0o7777;
  try {
    accessSync('/', constants.W_OK);
    return mode;
  }
  catch { return mode & ~0o222; }
});

backend_t wasmfs_create_root_dir(void) {
  return wasmfs_create_node_backend("/");
}

/* After WasmFS and the environment are set up, which both happen in
 * higher-priority constructors. */
__attribute__((constructor)) static void follow_host(void) {
  chmod("/", host_root_mode());

  char cwd[PATH_MAX];
  if (host_cwd(cwd, sizeof cwd) > 0)
    chdir(cwd);

  const char *tmp = getenv("TMPDIR");
  if (tmp != NULL && access(tmp, F_OK) != 0)
    wasmfs_create_directory(tmp, 0777, wasmfs_create_memory_backend());
}
