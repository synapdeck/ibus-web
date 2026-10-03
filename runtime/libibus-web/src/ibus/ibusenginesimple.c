/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */
#include <ibus.h>

G_DEFINE_TYPE(IBusEngineSimple, ibus_engine_simple, IBUS_TYPE_ENGINE)

static void
ibus_engine_simple_class_init(IBusEngineSimpleClass *klass G_GNUC_UNUSED) {
  /* Inherit the unhandled-key default: browser and OS own Compose and emoji. */
}

static void ibus_engine_simple_init(IBusEngineSimple *engine G_GNUC_UNUSED) {}
