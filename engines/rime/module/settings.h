/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: GPL-3.0-or-later */
#pragma once
#include <glib.h>

G_BEGIN_DECLS

/* Writes the YAML patches the settings ask for into Rime's user directory,
 * and follows the settings from then on. Call it before Rime is set up. */
void ibusweb_rime_settings_init(void);

/* Tells the settings that a deployment has ended and the deployer
 * returned, so that one that changed meanwhile can start the next. */
void ibusweb_rime_settings_deployed(void);

/* The page size the page stored, or 0 for the schema's own. */
int ibusweb_rime_page_size(void);

/* Sets the page size on every session's schema. */
void ibusweb_rime_page_size_changed(void);

/* Whether Rime's deployer is at work: from a deployment's start until it
 * returns, which is after it reports the deployment's end. */
gboolean ibusweb_rime_deploying(void);

G_END_DECLS
