/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */
#pragma once
#include <glib.h>

G_BEGIN_DECLS

G_GNUC_INTERNAL void ibusweb_settings_register(void);
/* Arguments are borrowed; stored values acquire their own references. The
 * instances are Init's a(ssa{sv}): schema id, path and stored values; the
 * patterns its a(ss): relocatable schema id and path pattern. */
G_GNUC_INTERNAL void ibusweb_settings_init(GVariant *instances,
                                           GVariant *patterns);
G_GNUC_INTERNAL int ibusweb_settings_changed(const char *path, const char *key,
                                             GVariant *value);
G_END_DECLS
