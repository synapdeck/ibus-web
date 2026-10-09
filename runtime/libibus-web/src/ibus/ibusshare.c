/* SPDX-FileCopyrightText: 2008-2015 Peng Huang <shawn.p.huang@gmail.com>
 * SPDX-FileCopyrightText: 2008-2015 Red Hat, Inc.
 * SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */
#include <ibus.h>

/* Registers the serializable types, so a variant naming one deserializes
 * before the type has otherwise been used. */
void ibus_init(void) {
  static gsize inited = 0;
  if (!g_once_init_enter(&inited))
    return;

  (void)IBUS_ERROR;
  g_type_ensure(IBUS_TYPE_TEXT);
  g_type_ensure(IBUS_TYPE_ATTRIBUTE);
  g_type_ensure(IBUS_TYPE_ATTR_LIST);
  g_type_ensure(IBUS_TYPE_COMPONENT);
  g_type_ensure(IBUS_TYPE_ENGINE_DESC);
  g_type_ensure(IBUS_TYPE_LOOKUP_TABLE);
  g_type_ensure(IBUS_TYPE_OBSERVED_PATH);

  g_once_init_leave(&inited, 1);
}

/* The runtime's pumping thread runs the default main context, so an
 * engine's own main loop never runs: these warn the first time and return
 * at once. */
void ibus_main(void) {
  static gsize warned = 0;
  if (g_once_init_enter(&warned)) {
    g_warning("%s: the runtime runs the main context", G_STRFUNC);
    g_once_init_leave(&warned, 1);
  }
}

void ibus_quit(void) {
  static gsize warned = 0;
  if (g_once_init_enter(&warned)) {
    g_warning("%s: the runtime runs the main context", G_STRFUNC);
    g_once_init_leave(&warned, 1);
  }
}
