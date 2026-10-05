// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
#include <stdio.h>
#include <xkbcommon/xkbcommon.h>
int main(int argc, char **argv) {
  if (argc != 2)
    return 1;
  struct xkb_context *ctx = xkb_context_new(XKB_CONTEXT_NO_DEFAULT_INCLUDES);
  if (!ctx || !xkb_context_include_path_append(ctx, argv[1]))
    return 2;
  const struct xkb_rule_names names = {"evdev", "pc105", "us", "", ""};
  struct xkb_keymap *map =
      xkb_keymap_new_from_names(ctx, &names, XKB_KEYMAP_COMPILE_NO_FLAGS);
  if (!map)
    return 3;
  printf("[");
  int comma = 0;
  for (xkb_keycode_t code = xkb_keymap_min_keycode(map);
       code <= xkb_keymap_max_keycode(map); code++) {
    xkb_level_index_t levels = xkb_keymap_num_levels_for_key(map, code, 0);
    if (!levels)
      continue;
    printf("%s[%u,[", comma++ ? "," : "", code - 8);
    for (xkb_level_index_t level = 0; level < levels; level++) {
      const xkb_keysym_t *syms;
      int n = xkb_keymap_key_get_syms_by_level(map, code, 0, level, &syms);
      if (n > 1)
        return 4;
      xkb_keysym_t sym = n == 0 ? XKB_KEY_NoSymbol : syms[0];
      printf("%s[%u,%u]", level ? "," : "", sym, xkb_keysym_to_utf32(sym));
    }
    printf("]]");
  }
  printf("]\n");
  xkb_keymap_unref(map);
  xkb_context_unref(ctx);
  return 0;
}
