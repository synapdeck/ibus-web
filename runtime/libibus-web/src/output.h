/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */
#pragma once
#include <glib.h>
#include <stdint.h>

/* Payloads are serialized on the calling thread; sequence numbers are assigned
 * when the pumping thread appends the record. Takes a reference, sinking
 * floats. */
G_GNUC_INTERNAL void ibusweb_output_append(uint32_t ic, uint16_t kind,
                                           GVariant *payload);

#ifdef IBUSWEB_TESTS
G_GNUC_INTERNAL void ibusweb_output_test_set_seq(uint32_t seq);
#endif
