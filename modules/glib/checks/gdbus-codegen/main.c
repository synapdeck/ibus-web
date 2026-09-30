/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */
#include <gio/gio.h>
#include <stdio.h>

/* Declared here rather than through the generated header, which only exists
 * in the build directory. */
GType example_counter_skeleton_get_type(void);
GType example_object_skeleton_get_type(void);

int main(void) {
  /* Each type's first instance runs the interface init functions
   * gdbus-codegen generated for it. */
  GObject *counter =
      g_object_new(example_counter_skeleton_get_type(), "total", 7, NULL);
  GObject *object =
      g_object_new(example_object_skeleton_get_type(), "g-object-path",
                   "/org/example/Counter", "counter", counter, NULL);

  int total = 0;
  g_object_get(counter, "total", &total, NULL);
  printf("counter %d %s\n", total,
         g_dbus_object_get_object_path(G_DBUS_OBJECT(object)));

  g_object_unref(object);
  g_object_unref(counter);
  return 0;
}
