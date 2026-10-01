/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */

#pragma once

#include "ibus-web/runtime.h"

/* The dispatcher's opcode table. */

G_GNUC_INTERNAL
int ibusweb_ops_add(IBusWebModule *module, uint32_t opcode, const char *name,
                    IBusWebOp op);

G_GNUC_INTERNAL
void ibusweb_ops_remove_module(IBusWebModule *module);

G_GNUC_INTERNAL
const char *ibusweb_module_get_name(IBusWebModule *module);
