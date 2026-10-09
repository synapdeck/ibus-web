/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */
#include "us-keymap.generated.h"
#include <ibus.h>
#include <stdlib.h>

G_DEFINE_TYPE(IBusKeymap, ibus_keymap, IBUS_TYPE_OBJECT)

static void ibus_keymap_class_init(IBusKeymapClass *klass G_GNUC_UNUSED) {}
static void ibus_keymap_init(IBusKeymap *keymap G_GNUC_UNUSED) {}

/* The page translates keys itself; engines that ask for a keymap get US, the
 * layout the page's `us` engines follow. */
IBusKeymap *ibus_keymap_get(const gchar *name) {
  static IBusKeymap *us;

  if (g_strcmp0(name, "us") != 0)
    return NULL;

  if (g_once_init_enter_pointer(&us)) {
    IBusKeymap *keymap =
        g_object_ref_sink(g_object_new(IBUS_TYPE_KEYMAP, NULL));
    keymap->name = g_strdup("us");
    g_once_init_leave_pointer(&us, keymap);
  }

  return g_object_ref(us);
}

static int compare_code(const void *code, const void *key) {
  return (int)*(const guint16 *)code - (int)((const UsKey *)key)->code;
}

guint ibus_keymap_lookup_keysym(IBusKeymap *keymap, guint16 keycode,
                                guint32 state) {
  if (keymap == NULL)
    return IBUS_VoidSymbol;

  const UsKey *key = bsearch(&keycode, us_keys, G_N_ELEMENTS(us_keys),
                             sizeof *us_keys, compare_code);
  if (key == NULL)
    return IBUS_VoidSymbol;

  /* Keypad levels follow NumLock alone and letters invert case under Lock;
   * Mod5 plays no part. */
  gboolean shift = (state & IBUS_SHIFT_MASK) != 0;
  gboolean lock = (state & IBUS_LOCK_MASK) != 0;
  gboolean upper = key->flags & US_KEY_KEYPAD   ? (state & IBUS_MOD2_MASK) != 0
                   : key->flags & US_KEY_LETTER ? shift != lock
                                                : shift;

  /* A key whose first level has no keysym stays 0, as in the page's
   * translation. */
  return upper && key->upper != 0 ? key->upper : key->lower;
}
