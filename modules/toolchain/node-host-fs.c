/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* Linked into programs that run under Node with WasmFS, so they see the
 * host's files at the paths the host gives them.
 *
 * Emscripten's own -sNODERAWFS under WasmFS roots the tree at Node's working
 * directory, so an absolute path such as /nix/store/... resolves under it.
 * Here the root is the host's /, and the working directory is Node's.
 *
 * A TMPDIR the host doesn't have is created in WasmFS's memory backend, where
 * the browser keeps temporary files. Host programs that give TMPDIR a
 * directory of their own are unaffected. */

#include <emscripten/em_js.h>
#include <emscripten/wasmfs.h>
#include <limits.h>
#include <stdlib.h>
#include <unistd.h>

EM_JS(int, host_cwd, (char *buf, int size), {
  const cwd = process.cwd();
  return lengthBytesUTF8(cwd) < size ? stringToUTF8(cwd, buf, size) : 0;
});

backend_t wasmfs_create_root_dir(void) {
  return wasmfs_create_node_backend("/");
}

/* After WasmFS and the environment are set up, which both happen in
 * higher-priority constructors. */
__attribute__((constructor)) static void follow_host(void) {
  char cwd[PATH_MAX];
  if (host_cwd(cwd, sizeof cwd) > 0)
    chdir(cwd);

  const char *tmp = getenv("TMPDIR");
  if (tmp != NULL && access(tmp, F_OK) != 0)
    wasmfs_create_directory(tmp, 0777, wasmfs_create_memory_backend());
}
