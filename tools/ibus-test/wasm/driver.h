// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
#pragma once
#include "../native/values.h"

/* Borrows a validated trace and mounted side-module path. */
gboolean ibus_test_wasm_run(JsonObject *trace, const gchar *module,
                            GLogLevelFlags runtime_fatal_mask);
