/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */
#include <ibus.h>

G_DEFINE_TYPE(IBusEngineSimple, ibus_engine_simple, IBUS_TYPE_ENGINE)

static void ibus_engine_simple_reset(IBusEngine *engine) {
  ibus_engine_hide_preedit_text(engine);
}

static void ibus_engine_simple_focus_out(IBusEngine *engine) {
  ibus_engine_simple_reset(engine);
  IBUS_ENGINE_CLASS(ibus_engine_simple_parent_class)->focus_out(engine);
}

static void ibus_engine_simple_class_init(IBusEngineSimpleClass *klass) {
  IBusEngineClass *engine_class = IBUS_ENGINE_CLASS(klass);
  engine_class->focus_out = ibus_engine_simple_focus_out;
  engine_class->reset = ibus_engine_simple_reset;
  /* Browser and OS still own Compose and emoji for unhandled keys. */
}

static void ibus_engine_simple_init(IBusEngineSimple *engine G_GNUC_UNUSED) {}
