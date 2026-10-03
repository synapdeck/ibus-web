// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: LGPL-2.1-or-later
#include <ibus.h>
#include <stdexcept>

extern "C" gboolean test_throwing_key_event(IBusEngine *, guint, guint, guint) {
  throw std::runtime_error("thrown by an engine");
}
