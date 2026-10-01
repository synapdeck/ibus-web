/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* Linked into programs that run under Node with WasmFS, so they see the
 * host's files at the paths the host gives them.
 *
 * Emscripten's own -sNODERAWFS under WasmFS roots the tree at Node's working
 * directory, so an absolute path such as /nix/store/... resolves under it.
 * Here the root is the host's /, and the working directory is Node's. */

#include <emscripten/em_js.h>
#include <emscripten/wasmfs.h>
#include <limits.h>
#include <unistd.h>

EM_JS(int, host_cwd, (char *buf, int size), {
  const cwd = process.cwd();
  return lengthBytesUTF8(cwd) < size ? stringToUTF8(cwd, buf, size) : 0;
});

backend_t wasmfs_create_root_dir(void) {
  return wasmfs_create_node_backend("/");
}

/* After WasmFS is set up, which happens in a higher-priority constructor. */
__attribute__((constructor)) static void follow_host(void) {
  char cwd[PATH_MAX];
  if (host_cwd(cwd, sizeof cwd) > 0)
    chdir(cwd);
}
