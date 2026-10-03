/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */
#include <ibus.h>

G_DEFINE_TYPE(IBusKeymap, ibus_keymap, IBUS_TYPE_OBJECT)

static void ibus_keymap_class_init(IBusKeymapClass *klass G_GNUC_UNUSED) {}
static void ibus_keymap_init(IBusKeymap *keymap G_GNUC_UNUSED) {}

IBusKeymap *ibus_keymap_get(const gchar *name G_GNUC_UNUSED) {
  /* The router already computes layout-us keyvals from browser event codes. */
  return NULL;
}

guint ibus_keymap_lookup_keysym(IBusKeymap *keymap G_GNUC_UNUSED,
                                guint16 keycode, guint32 state G_GNUC_UNUSED) {
  return keycode;
}
