/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* Prints, as JSON, the values the TypeScript host and scenarios share with
 * the C side, as the WebAssembly target defines them: the spike opcodes, the
 * runtime's return values the host checks for, the IndexedDB backend's flags,
 * and where mallinfo() reports the bytes in use. */

#include "spike.h"

#include <errno.h>
#include <ibus-web/wasmfs-idb.h>
#include <malloc.h>
#include <stddef.h>
#include <stdio.h>

int main(void) {
  const char *sep = "";
  printf("{\"ops\": {");
#define PRINT_OP(name, opcode)                                                 \
  printf("%s\"%s\": %d", sep, #name, SPIKE_OP_##name);                         \
  sep = ", ";
  SPIKE_OPS(PRINT_OP)
#undef PRINT_OP
  printf("}, \"pumpError\": %d, \"waitTimedOut\": %d", IBUSWEB_PUMP_ERROR,
         -ETIMEDOUT);
  printf(", \"idbReadOnly\": %u", WASMFS_IDB_READ_ONLY);
  printf(", \"mallinfo\": {\"bytes\": %zu, \"inUseOffset\": %zu}}\n",
         sizeof(struct mallinfo), offsetof(struct mallinfo, uordblks));
  return 0;
}
