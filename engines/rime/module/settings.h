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

/* What the settings give the file Rime compiles for id, as a SHA-256 in
 * hexadecimal: "default" for default.yaml, "ibus_rime" for ibus_rime.yaml,
 * or a schema's id, whose compiled config takes in default.custom.yaml's
 * presets and its own patch. */
char *ibusweb_rime_fingerprint(const char *id);

/* What the prebuilt data was compiled with: no patch at all. */
char *ibusweb_rime_prebuilt_fingerprint(void);

/* Compiles default.yaml and ibus_rime.yaml where the settings changed them,
 * and the schemas of the engines open, and their dependencies, where the
 * settings changed them since they were last compiled. */
void ibusweb_rime_compile_open(void);

/* The page size the page stored, or 0 for the schema's own. */
int ibusweb_rime_page_size(void);

/* Sets the page size on every session's schema. */
void ibusweb_rime_page_size_changed(void);

/* Whether Rime's deployer is at work: from a deployment's start until it
 * returns, which is after it reports the deployment's end. */
gboolean ibusweb_rime_deploying(void);

G_END_DECLS
