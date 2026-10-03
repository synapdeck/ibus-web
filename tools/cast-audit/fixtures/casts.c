// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
#include <glib-object.h>

static void one(gpointer value) { (void)value; }
static void two(gpointer value, gpointer data) {
  (void)value;
  (void)data;
}

void audit_fixture(void) {
  GFunc mismatch = (GFunc)one;
  GCallback callback = G_CALLBACK(one);
  GFunc matching = (GFunc)two;
  (void)mismatch;
  (void)callback;
  (void)matching;
}

static void takes_int(int value) { (void)value; }

void audit_direct_call(void) {
  void (*call)(void) = (void (*)(void))takes_int;
  call();
}
