/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: GPL-3.0-or-later */
#pragma once
#include <glib.h>

G_BEGIN_DECLS

/* Writes the YAML patches the settings ask for into Rime's user directory,
 * and follows the settings from then on. Call it before Rime is set up. */
void ibusweb_rime_settings_init(void);

/* Tells the settings that a deployment has ended, so that one that changed
 * meanwhile can start the next. */
void ibusweb_rime_settings_deployed(void);

G_END_DECLS
