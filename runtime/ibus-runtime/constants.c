/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* The host uses the target's ABI, errno and backend flags when serving
 * requests. */
#include <errno.h>
#include <ibus-web/protocol.h>
#include <ibus-web/runtime.h>
#include <ibus-web/wasmfs-idb.h>
#include <stdio.h>

int main(void) {
  printf("{\"pumpError\": %d, \"waitTimedOut\": %d", IBUSWEB_PUMP_ERROR,
         -ETIMEDOUT);
  printf(", \"idbReadOnly\": %u", WASMFS_IDB_READ_ONLY);
  printf(", \"runtimeAbi\": %u, \"protocol\": %u, \"canceled\": %d}\n",
         IBUSWEB_RUNTIME_ABI, IBUSWEB_PROTOCOL_VERSION, -ECANCELED);
  return 0;
}
