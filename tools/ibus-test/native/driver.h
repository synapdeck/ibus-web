// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
#pragma once
#include "values.h"
gboolean ibus_test_run(JsonArray *steps, const char *address,
                       const char *destination, const char *factory,
                       gint timeout_ms);
