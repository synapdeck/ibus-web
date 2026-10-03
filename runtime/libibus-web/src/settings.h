/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */
#pragma once
#include <glib.h>

G_BEGIN_DECLS

G_GNUC_INTERNAL void ibusweb_settings_register(void);
/* Arguments are borrowed; stored values acquire their own references. */
G_GNUC_INTERNAL void ibusweb_settings_init(GVariant *snapshot);
G_GNUC_INTERNAL int ibusweb_settings_changed(const char *schema,
                                             const char *key, GVariant *value);
G_END_DECLS
