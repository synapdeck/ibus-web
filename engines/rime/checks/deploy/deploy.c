/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: GPL-3.0-or-later */
#include "../golden/harness.h"

static gchar **dictionaries;

/* The files of Rime's staging directory with suffix, sorted. */
static gchar *staged(const gchar *suffix) {
  g_autoptr(GDir) dir = g_dir_open("/engines/rime/build", 0, NULL);
  g_assert_nonnull(dir);
  g_autoptr(GPtrArray) names = g_ptr_array_new_with_free_func(g_free);
  const gchar *name;
  while ((name = g_dir_read_name(dir)) != NULL) {
    if (g_str_has_suffix(name, suffix))
      g_ptr_array_add(names, g_strdup(name));
  }
  g_ptr_array_sort_values(names, (GCompareFunc)g_strcmp0);
  g_ptr_array_add(names, NULL);
  return g_strjoinv(" ", (gchar **)names->pdata);
}

static void preedit(Fixture *fixture, const gchar *expected) {
  g_autofree gchar *text = golden_preedit(fixture);
  g_assert_cmpstr(text, ==, expected);
}

static guint page_size(Fixture *fixture) {
  IBusLookupTable *table = IBUS_LOOKUP_TABLE(
      golden_object(golden_last(fixture, IBUSWEB_REC_UPDATE_LOOKUP_TABLE),
                    IBUS_TYPE_LOOKUP_TABLE));
  guint size = ibus_lookup_table_get_page_size(table);
  g_object_unref(table);
  return size;
}

/* The first deployment, with only the common data installed, compiles the
 * configs and leaves every table and prism to the prebuilt data. An
 * engine works once its dictionaries are there. */
static void without_dictionaries(Fixture *fixture,
                                 gconstpointer data G_GNUC_UNUSED) {
  g_autofree gchar *tables = staged(".bin");
  g_assert_cmpstr(tables, ==, "");
  g_autofree gchar *configs = staged(".schema.yaml");
  g_assert_true(strstr(configs, "rime_ice.schema.yaml") != NULL);

  for (gchar **path = dictionaries; *path != NULL; path++)
    golden_mount(*path);
  golden_create(fixture, "rime:luna_pinyin");
  golden_type(fixture, "hanzi");
  preedit(fixture, "漢字");
  g_assert_cmpuint(page_size(fixture), ==, 5);
}

/* A setting that changes every schema redeploys over the prebuilt data: the
 * installed dictionaries' prisms are rebuilt for the new configs, every
 * table is reused, and the prisms of dictionaries not installed wait for
 * their data. */
static void redeploy(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "rime:luna_pinyin");
  golden_clear(fixture);
  golden_setting(fixture, RIME_PATH, "ascii-toggle-key",
                 g_variant_new_string("caps-lock"));
  golden_wait_log(fixture, "Rime is ready.");
  golden_clear(fixture);

  g_autofree gchar *tables = staged(".table.bin");
  g_assert_cmpstr(tables, ==, "");
  g_autofree gchar *reverse = staged(".reverse.bin");
  g_assert_cmpstr(reverse, ==, "");
  g_autofree gchar *prisms = staged(".prism.bin");
  g_assert_true(strstr(prisms, "luna_pinyin.prism.bin") != NULL);
  g_assert_null(strstr(prisms, "rime_ice.prism.bin"));
  g_assert_null(strstr(prisms, "cangjie5.prism.bin"));

  g_autofree gchar *config = NULL;
  g_assert_true(g_file_get_contents("/engines/rime/build/default.yaml", &config,
                                    NULL, NULL));
  g_assert_nonnull(strstr(config, "Shift_L: noop"));

  golden_type(fixture, "hanzi");
  preedit(fixture, "漢字");
}

int main(int argc, char **argv) {
  g_test_init(&argc, &argv, NULL);
  gchar *schemas_dir = NULL, *module = NULL, *instances = NULL;
  gchar **store_paths = NULL;
  GOptionEntry options[] = {
      {"schemas", 0, 0, G_OPTION_ARG_STRING, &schemas_dir,
       "Compiled GSettings schemas directory", "DIR"},
      {"module", 0, 0, G_OPTION_ARG_FILENAME, &module, "Engine side module",
       "FILE"},
      {"instances", 0, 0, G_OPTION_ARG_FILENAME, &instances,
       "The module's settings instances", "FILE"},
      {"store-path", 0, 0, G_OPTION_ARG_FILENAME_ARRAY, &store_paths,
       "A store path installed at start", "PATH"},
      {"dictionary", 0, 0, G_OPTION_ARG_FILENAME_ARRAY, &dictionaries,
       "A dictionary's store path, installed later", "PATH"},
      {NULL}};
  GOptionContext *context_options = g_option_context_new(NULL);
  g_option_context_add_main_entries(context_options, options, NULL);
  GError *error = NULL;
  g_assert_true(g_option_context_parse(context_options, &argc, &argv, &error));
  g_assert_no_error(error);
  g_assert_nonnull(store_paths);
  g_assert_nonnull(dictionaries);

  golden_init(schemas_dir, module, instances, "/engines/rime",
              (const gchar *const *)store_paths);
  g_free(schemas_dir);
  g_free(module);
  g_free(instances);
  g_strfreev(store_paths);
  g_option_context_free(context_options);

  g_test_add("/rime-deploy/without-dictionaries", Fixture, NULL, golden_setup,
             without_dictionaries, golden_teardown);
  g_test_add("/rime-deploy/redeploy", Fixture, NULL, golden_setup, redeploy,
             golden_teardown);
  return g_test_run();
}
