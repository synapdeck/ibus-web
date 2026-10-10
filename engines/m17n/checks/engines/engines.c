/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later */
#include "../golden/harness.h"

/* Making the engine opens its input method; the keys run it, whatever it
 * makes of them. A warning from either fails the case. */
static void engine(Fixture *fixture, gconstpointer data) {
  golden_create(fixture, data);
  golden_key(fixture, IBUS_a, 30, 0);
  golden_key(fixture, IBUS_1, 2, 0);
  golden_key(fixture, IBUS_space, 57, 0);
  golden_key(fixture, IBUS_BackSpace, 14, 0);
}

int main(int argc, char **argv) {
  g_test_init(&argc, &argv, NULL);
  gchar *schemas_dir = NULL, *module = NULL, *instances = NULL, *engines = NULL;
  GOptionEntry options[] = {{"schemas", 0, 0, G_OPTION_ARG_STRING, &schemas_dir,
                             "Compiled GSettings schemas directory", "DIR"},
                            {"module", 0, 0, G_OPTION_ARG_FILENAME, &module,
                             "Engine side module", "FILE"},
                            {"instances", 0, 0, G_OPTION_ARG_FILENAME,
                             &instances, "The module's settings instances",
                             "FILE"},
                            {"engines", 0, 0, G_OPTION_ARG_FILENAME, &engines,
                             "The engines' names, one a line", "FILE"},
                            {NULL}};
  GOptionContext *context = g_option_context_new(NULL);
  g_option_context_add_main_entries(context, options, NULL);
  GError *error = NULL;
  g_assert_true(g_option_context_parse(context, &argc, &argv, &error));
  g_assert_no_error(error);
  g_assert_nonnull(schemas_dir);
  g_assert_nonnull(module);
  g_assert_nonnull(instances);
  g_assert_nonnull(engines);
  golden_init(schemas_dir, module, instances, NULL, 0);

  g_autofree gchar *contents = NULL;
  g_assert_true(g_file_get_contents(engines, &contents, NULL, NULL));
  /* The names are the cases' data for the whole run. */
  gchar **names = g_strsplit(g_strchomp(contents), "\n", -1);
  for (gchar **name = names; *name != NULL; name++) {
    g_autofree gchar *path = g_strdup_printf("/m17n-engines/%s", *name);
    g_test_add(path, Fixture, *name, golden_setup, engine, golden_teardown);
  }

  g_free(schemas_dir);
  g_free(module);
  g_free(instances);
  g_free(engines);
  g_option_context_free(context);
  return g_test_run();
}
