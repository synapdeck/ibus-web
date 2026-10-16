/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* Test side module opcodes and the allocator's layout, evaluated for the
 * WebAssembly target. */

#include "test-ops.h"

#include <malloc.h>
#include <stddef.h>
#include <stdio.h>

int main(void) {
  const char *sep = "";
  printf("{\"ops\": {");
#define PRINT_OP(name, opcode)                                                 \
  printf("%s\"%s\": %d", sep, #name, TEST_OP_##name);                          \
  sep = ", ";
  TEST_OPS(PRINT_OP)
#undef PRINT_OP
  printf("}");
  printf(", \"mallinfo\": {\"bytes\": %zu, \"inUseOffset\": %zu, "
         "\"peakOffset\": %zu}}\n",
         sizeof(struct mallinfo), offsetof(struct mallinfo, uordblks),
         offsetof(struct mallinfo, usmblks));
  return 0;
}
