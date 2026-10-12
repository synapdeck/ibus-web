/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: GPL-3.0-or-later */
#include "../golden/harness.h"
#include <fcntl.h>
#include <unistd.h>

/* rime_ice's user dictionary, a LevelDB database. */
#define USERDB "rime_ice.userdb"

static gchar *home;

static gchar *in_userdb(const gchar *name) {
  return g_build_filename(home, USERDB, name, NULL);
}

static gchar *first_candidate(Fixture *fixture) {
  IBusLookupTable *table = IBUS_LOOKUP_TABLE(
      golden_object(golden_last(fixture, IBUSWEB_REC_UPDATE_LOOKUP_TABLE),
                    IBUS_TYPE_LOOKUP_TABLE));
  gchar *text = g_strdup(ibus_lookup_table_get_candidate(table, 0)->text);
  g_object_unref(table);
  return text;
}

/* The page's third candidate, chosen, is learned. */
static void learn(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "rime:rime_ice");
  golden_type(fixture, "zhong");
  g_autofree gchar *first = first_candidate(fixture);
  g_assert_cmpstr(first, ==, "中");
  golden_clear(fixture);
  g_assert_cmpint(golden_request(fixture, IBUSWEB_REQ_CANDIDATE_CLICKED,
                                 g_variant_new("(uuu)", 2, 1, 0)),
                  ==, 0);
  g_autofree gchar *text = golden_committed(fixture);
  g_assert_cmpstr(text, ==, "种");
  golden_destroy(fixture);

  /* The program ends without closing the database, as a Worker does: the
   * write is in its log, and its lock file stays behind. */
  g_autofree gchar *lock = in_userdb("LOCK");
  g_assert_true(g_file_test(lock, G_FILE_TEST_IS_REGULAR));
}

/* A host killed mid-write leaves a torn record at the end of the log, which
 * opening the database drops. */
static void tear_log(void) {
  g_autofree gchar *dir = g_build_filename(home, USERDB, NULL);
  g_autoptr(GDir) entries = g_dir_open(dir, 0, NULL);
  g_assert_nonnull(entries);
  const gchar *name;
  guint torn = 0;
  while ((name = g_dir_read_name(entries)) != NULL) {
    if (!g_str_has_suffix(name, ".log"))
      continue;
    g_autofree gchar *path = g_build_filename(dir, name, NULL);
    int fd = open(path, O_WRONLY | O_APPEND);
    g_assert_cmpint(fd, >=, 0);
    static const guint8 partial[] = {0x12, 0x34, 0x56, 0x78, 0x40, 0x00, 0x01};
    g_assert_cmpint(write(fd, partial, sizeof partial), ==, sizeof partial);
    g_assert_cmpint(close(fd), ==, 0);
    torn++;
  }
  g_assert_cmpuint(torn, ==, 1);
}

/* After a restart on the same storage, the learned candidate comes first,
 * whatever a torn write left behind. */
static void remembered(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  tear_log();
  golden_create(fixture, "rime:rime_ice");
  golden_type(fixture, "zhong");
  g_autofree gchar *first = first_candidate(fixture);
  g_assert_cmpstr(first, ==, "种");
}

/* Each time the dictionary is opened again, LevelDB turns its log into a
 * table; at four, it compacts them on its own thread. */
static void compaction(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  static const gchar *const words[] = {"zhong", "guo", "ren", "min", "hao"};
  for (guint i = 0; i < G_N_ELEMENTS(words); i++) {
    golden_create(fixture, "rime:rime_ice");
    golden_type(fixture, words[i]);
    golden_clear(fixture);
    g_assert_cmpint(golden_request(fixture, IBUSWEB_REQ_CANDIDATE_CLICKED,
                                   g_variant_new("(uuu)", 1, 1, 0)),
                    ==, 0);
    golden_destroy(fixture);
  }
  g_autofree gchar *log = in_userdb("LOG");
  golden_wait_file(log, "Compacted 4@0 + 0@1 files");
}

int main(int argc, char **argv) {
  g_test_init(&argc, &argv, NULL);
  gchar *schemas_dir = NULL, *module = NULL, *instances = NULL, *step = NULL;
  GOptionEntry options[] = {{"schemas", 0, 0, G_OPTION_ARG_STRING, &schemas_dir,
                             "Compiled GSettings schemas directory", "DIR"},
                            {"module", 0, 0, G_OPTION_ARG_FILENAME, &module,
                             "Engine side module", "FILE"},
                            {"instances", 0, 0, G_OPTION_ARG_FILENAME,
                             &instances, "The module's settings instances",
                             "FILE"},
                            {"step", 0, 0, G_OPTION_ARG_STRING, &step,
                             "learn, remember or compact", "STEP"},
                            {NULL}};
  GOptionContext *context_options = g_option_context_new(NULL);
  g_option_context_add_main_entries(context_options, options, NULL);
  GError *error = NULL;
  g_assert_true(g_option_context_parse(context_options, &argc, &argv, &error));
  g_assert_no_error(error);
  g_assert_nonnull(step);

  /* Learning and remembering keep the user's files in the working
   * directory, which outlives each program. LevelDB's thread reaches those
   * through this one, which can't serve it while closing the database
   * waits for that thread, so compaction keeps them in memory, as the
   * IndexedDB backend's own thread would. */
  if (g_str_equal(step, "compact")) {
    home = g_strdup("/engines/rime");
  } else {
    golden_mount_host("/host");
    home = g_strdup("/host/engines/rime");
  }
  golden_init(schemas_dir, module, instances, home, NULL);
  g_free(schemas_dir);
  g_free(module);
  g_free(instances);
  g_option_context_free(context_options);

  if (g_str_equal(step, "learn"))
    g_test_add("/rime-userdb/learn", Fixture, NULL, golden_setup, learn,
               golden_teardown);
  else if (g_str_equal(step, "remember"))
    g_test_add("/rime-userdb/remember", Fixture, NULL, golden_setup, remembered,
               golden_teardown);
  else
    g_test_add("/rime-userdb/compaction", Fixture, NULL, golden_setup,
               compaction, golden_teardown);
  int result = g_test_run();
  g_free(step);
  return result;
}
