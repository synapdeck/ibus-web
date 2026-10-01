/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* A side module to dlopen() while threads run: one function a thread can
 * call to show it has the module loaded. */

int side_value(void) { return 42; }
