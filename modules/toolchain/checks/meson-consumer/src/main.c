/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* Exercises zlib and libffi once each, as found through pkg-config. */
#ifndef IBUS_WEB_RECIPE_CFLAGS
#error "the recipe's NIX_CFLAGS_COMPILE did not reach the compiler"
#endif

#include <ffi.h>
#include <stdio.h>
#include <string.h>
#include <zlib.h>

static int add(int a, int b) { return a + b; }

static int zlib_round_trip(void) {
  const char text[] = "hello hello hello hello";
  unsigned char packed[128];
  char unpacked[sizeof text];
  uLongf packed_len = sizeof packed;
  uLongf unpacked_len = sizeof unpacked;

  if (compress(packed, &packed_len, (const Bytef *)text, sizeof text) != Z_OK)
    return 0;
  if (uncompress((Bytef *)unpacked, &unpacked_len, packed, packed_len) != Z_OK)
    return 0;
  return unpacked_len == sizeof text &&
         memcmp(text, unpacked, sizeof text) == 0;
}

static int ffi_add(void) {
  ffi_cif cif;
  ffi_type *arg_types[2] = {&ffi_type_sint, &ffi_type_sint};
  int a = 40, b = 2;
  void *args[2] = {&a, &b};
  ffi_arg result = 0;

  if (ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 2, &ffi_type_sint, arg_types) !=
      FFI_OK)
    return -1;
  ffi_call(&cif, FFI_FN(add), &result, args);
  return (int)result;
}

int main(void) {
  printf("zlib %s\n", zlib_round_trip() ? "ok" : "failed");
  printf("ffi %d\n", ffi_add());
  return 0;
}
