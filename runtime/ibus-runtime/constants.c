/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* The host uses the target's ABI, errno and backend flags when serving
 * requests, and its file-system constants when it installs engine data
 * through Emscripten's FS. */
#include <errno.h>
#include <fcntl.h>
#include <ibus-web/protocol.h>
#include <ibus-web/runtime.h>
#include <ibus-web/wasmfs-idb.h>
#include <stdio.h>
#include <sys/stat.h>

int main(void) {
  printf("{\"pumpError\": %d, \"waitTimedOut\": %d", IBUSWEB_PUMP_ERROR,
         -ETIMEDOUT);
  printf(", \"idbReadOnly\": %u", WASMFS_IDB_READ_ONLY);
  printf(", \"runtimeAbi\": %u, \"protocol\": %u, \"canceled\": %d",
         IBUSWEB_RUNTIME_ABI, IBUSWEB_PROTOCOL_VERSION, -ECANCELED);

  printf(
      ", \"fs\": {\"errno\": {\"EEXIST\": %d, \"EFBIG\": %d, \"EINVAL\": %d, "
      "\"EISDIR\": %d, \"ENOENT\": %d, \"ENOTDIR\": %d, "
      "\"EOPNOTSUPP\": %d}",
      EEXIST, EFBIG, EINVAL, EISDIR, ENOENT, ENOTDIR, EOPNOTSUPP);
  printf(", \"open\": {\"O_WRONLY\": %d, \"O_CREAT\": %d, \"O_TRUNC\": %d, "
         "\"O_NOFOLLOW\": %d}",
         O_WRONLY, O_CREAT, O_TRUNC, O_NOFOLLOW);
  printf(", \"mode\": {\"S_IFMT\": %d, \"S_IFDIR\": %d, \"S_IFLNK\": %d}}}\n",
         S_IFMT, S_IFDIR, S_IFLNK);
  return 0;
}
