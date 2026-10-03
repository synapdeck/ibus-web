/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */
#pragma once
#include <ibus.h>
#include <stdint.h>

G_GNUC_INTERNAL IBusEngine *
ibusweb_factory_create(uint32_t ic, const char *name, int *error);
G_GNUC_INTERNAL void ibusweb_engine_set_ic(IBusEngine *engine, uint32_t ic);
G_GNUC_INTERNAL uint32_t ibusweb_engine_get_ic(IBusEngine *engine);
