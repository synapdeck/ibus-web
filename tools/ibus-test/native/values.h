// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
#pragma once
#include <gio/gio.h>
#include <json-glib/json-glib.h>
JsonNode *ibus_test_value(GVariant *value);
GVariant *ibus_test_args(const char *text, GError **error);
void ibus_test_write(JsonNode *record);
