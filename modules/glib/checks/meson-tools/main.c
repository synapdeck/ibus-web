/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */
#include <gio/gio.h>
#include <stdio.h>

/* Declared here rather than through the generated headers, which the
 * repository-wide clangd check, parsing sources outside any build, can't
 * see. */
GType example_counter_skeleton_get_type(void);
GType example_object_skeleton_get_type(void);
GResource *example_get_resource(void);
GType example_color_get_type(void);
void example_marshal_VOID__INT_STRING(GClosure *closure, GValue *return_value,
                                      guint n_param_values,
                                      const GValue *param_values,
                                      gpointer invocation_hint,
                                      gpointer marshal_data);

static void on_marshalled(gpointer instance, gint number, const char *text,
                          gpointer user_data) {
  (void)instance;
  (void)user_data;
  printf("marshal %d %s\n", number, text);
}

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

  GBytes *xml =
      g_resource_lookup_data(example_get_resource(), "/org/example/example.xml",
                             G_RESOURCE_LOOKUP_FLAGS_NONE, NULL);
  gsize size = 0;
  const char *data = xml ? g_bytes_get_data(xml, &size) : NULL;
  printf("resource %d\n",
         data != NULL &&
             g_strstr_len(data, size, "org.example.Counter") != NULL);
  g_clear_pointer(&xml, g_bytes_unref);

  GEnumClass *colors = g_type_class_ref(example_color_get_type());
  printf("enum %s\n", g_enum_get_value(colors, 1)->value_nick);
  g_type_class_unref(colors);

  GClosure *closure = g_cclosure_new(G_CALLBACK(on_marshalled), NULL, NULL);
  g_closure_set_marshal(closure, example_marshal_VOID__INT_STRING);
  GValue params[3] = {G_VALUE_INIT, G_VALUE_INIT, G_VALUE_INIT};
  g_value_init(&params[0], G_TYPE_POINTER);
  g_value_init(&params[1], G_TYPE_INT);
  g_value_set_int(&params[1], 3);
  g_value_init(&params[2], G_TYPE_STRING);
  g_value_set_static_string(&params[2], "three");
  g_closure_invoke(closure, NULL, 3, params, NULL);
  for (int i = 0; i < 3; i++)
    g_value_unset(&params[i]);
  g_closure_unref(closure);
  return 0;
}
