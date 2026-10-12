/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */

#pragma once

#include "ibus-web/runtime.h"

G_BEGIN_DECLS

/* The dispatcher's opcode table. */

G_GNUC_INTERNAL
int ibusweb_ops_add(IBusWebModule *module, uint32_t opcode, const char *name,
                    IBusWebOp op);

G_GNUC_INTERNAL
void ibusweb_ops_remove_module(IBusWebModule *module);

G_GNUC_INTERNAL
const char *ibusweb_module_get_name(IBusWebModule *module);

/* Calls every registered module's persist function, in registration order. */
G_GNUC_INTERNAL
void ibusweb_modules_persist(void);

/* Calls op, opcode's operation. Returns 0, or -ECANCELED if it threw a C++
 * exception, which leaves reply partly written; state that C frames between
 * the throw and op held stays as the exception left it. Exceptions that
 * aren't C++ ones propagate to the caller. */
G_GNUC_INTERNAL
int ibusweb_ops_call(uint32_t opcode, IBusWebOp op, const uint8_t *payload,
                     uint32_t len, GString *reply);

G_END_DECLS
