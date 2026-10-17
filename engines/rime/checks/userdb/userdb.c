/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: GPL-3.0-or-later */
#include "../golden/harness.h"
#include <fcntl.h>
#include <glib/gstdio.h>
#include <string.h>
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

/* Whether LevelDB's log holds text: what the dictionary has written since it
 * was opened. */
static gboolean log_holds(const gchar *text) {
  g_autofree gchar *dir = g_build_filename(home, USERDB, NULL);
  g_autoptr(GDir) entries = g_dir_open(dir, 0, NULL);
  g_assert_nonnull(entries);
  const gchar *name;
  while ((name = g_dir_read_name(entries)) != NULL) {
    if (!g_str_has_suffix(name, ".log"))
      continue;
    g_autofree gchar *path = g_build_filename(dir, name, NULL);
    g_autofree gchar *contents = NULL;
    gsize length;
    g_assert_true(g_file_get_contents(path, &contents, &length, NULL));
    gsize size = strlen(text);
    for (gsize at = 0; at + size <= length; at++)
      if (memcmp(contents + at, text, size) == 0)
        return TRUE;
  }
  return FALSE;
}

static gboolean in_log(gconstpointer text) { return log_holds(text); }

/* Chooses the page's candidate at index, returning what it commits. */
static gchar *choose(Fixture *fixture, const gchar *keys, guint index) {
  golden_type(fixture, keys);
  golden_clear(fixture);
  g_assert_cmpint(golden_request(fixture, IBUSWEB_REQ_CANDIDATE_CLICKED,
                                 g_variant_new("(uuu)", index, 1, 0)),
                  ==, 0);
  return golden_committed(fixture);
}

/* The page's third candidate, chosen, is learned. Rime holds the learning in
 * an open transaction, which Persist commits with the engine still open. */
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
  g_assert_false(log_holds("种"));

  golden_empty_request(fixture, IBUSWEB_REQ_PERSIST);
  g_assert_true(log_holds("种"));
  golden_destroy(fixture);

  /* The program ends without closing the database, as a Worker does: the
   * write is in its log, and its lock file stays behind. */
  g_autofree gchar *lock = in_userdb("LOCK");
  g_assert_true(g_file_test(lock, G_FILE_TEST_IS_REGULAR));
}

/* The next key takes in a commit's learning without writing it, which waits
 * until input has paused for 5 s. */
static void idle(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "rime:rime_ice");
  g_autofree gchar *text = choose(fixture, "guo", 2);
  gint64 typed = g_get_monotonic_time();
  golden_type(fixture, "guo");
  g_autofree gchar *first = first_candidate(fixture);
  g_assert_cmpstr(first, ==, text);
  g_assert_false(log_holds(text));

  g_assert_true(golden_pump_until(fixture, in_log, text, 30000));
  g_assert_cmpint(g_get_monotonic_time() - typed, >=, 5 * G_USEC_PER_SEC);
}

/* A Backspace right after a commit takes its learning back, leaving Persist
 * nothing to write. */
static void revert(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "rime:rime_ice");
  g_autofree gchar *text = choose(fixture, "ren", 2);
  g_assert_cmpint(golden_key(fixture, IBUS_BackSpace, 14, 0), ==, 0);

  golden_empty_request(fixture, IBUSWEB_REQ_PERSIST);
  g_assert_false(log_holds(text));
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

/* The user directory's entries, sorted, joined by spaces. */
static gchar *home_entries(void) {
  g_autoptr(GDir) entries = g_dir_open(home, 0, NULL);
  g_assert_nonnull(entries);
  g_autoptr(GPtrArray) names = g_ptr_array_new_with_free_func(g_free);
  const gchar *name;
  while ((name = g_dir_read_name(entries)) != NULL)
    g_ptr_array_add(names, g_strdup(name));
  g_ptr_array_sort_values(names, (GCompareFunc)g_strcmp0);
  g_ptr_array_add(names, NULL);
  return g_strjoinv(" ", (gchar **)names->pdata);
}

/* Breaks the database's CURRENT, which LevelDB then reports as corrupt. */
static void break_current(void) {
  g_autofree gchar *current = in_userdb("CURRENT");
  g_assert_true(g_file_set_contents(current, "MANIFEST-000002", -1, NULL));
}

static gboolean ready_at_least(gconstpointer data) {
  const struct {
    Fixture *fixture;
    guint count;
  } *wait = data;
  return golden_count_log(wait->fixture, "Rime is ready.") >= wait->count;
}

/* Waits for the end of a deployment that began after the fixture's last. */
static void wait_redeployed(Fixture *fixture) {
  struct {
    Fixture *fixture;
    guint count;
  } wait = {fixture, golden_count_log(fixture, "Rime is ready.") + 1};
  g_assert_true(golden_pump_until(fixture, ready_at_least, &wait, 60000));
}

/* An open that fails for anything but corruption, here a lock file that is
 * a directory, disables the dictionary for the session: Rime types from its
 * shipped dictionary, schedules no recovery and renames nothing. */
static void io_error(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  g_autofree gchar *lock = in_userdb("LOCK");
  g_assert_cmpint(g_unlink(lock), ==, 0);
  g_assert_cmpint(g_mkdir(lock, 0755), ==, 0);
  g_autofree gchar *before = home_entries();

  golden_expect_log(G_LOG_LEVEL_WARNING,
                    "*db 'rime_ice' is disabled, as it can't be opened: IO "
                    "error: *LOCK*");
  golden_create(fixture, "rime:rime_ice");
  golden_type(fixture, "zhong");
  g_autofree gchar *first = first_candidate(fixture);
  g_assert_cmpstr(first, ==, "中");
  golden_assert_expected_logs();

  g_assert_cmpuint(golden_count_log(fixture, "Rime is under maintenance ..."),
                   ==, 0);
  g_autofree gchar *after = home_entries();
  g_assert_cmpstr(after, ==, before);
  g_assert_cmpint(g_rmdir(lock), ==, 0);
}

/* Rime logs an error, a critical, for a database that is corrupt, which the
 * harness expects as a record rather than where it is logged. */
static void criticals_as_records(void) {
  g_log_set_always_fatal(G_LOG_FATAL_MASK);
}

/* A database LevelDB reports as corrupt, its CURRENT broken and its log
 * torn, is repaired in place, keeping what it learned. */
static void repaired(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  criticals_as_records();
  break_current();
  tear_log();
  g_autofree gchar *before = home_entries();

  golden_expect_log(G_LOG_LEVEL_CRITICAL,
                    "*Error opening db 'rime_ice': Corruption: *");
  golden_create(fixture, "rime:rime_ice");
  wait_redeployed(fixture);
  golden_assert_expected_logs();

  golden_type(fixture, "zhong");
  g_autofree gchar *first = first_candidate(fixture);
  g_assert_cmpstr(first, ==, "种");
  g_autofree gchar *after = home_entries();
  g_assert_cmpstr(after, ==, before);
}

/* Whether any file under dir holds text. */
static gboolean tree_holds(const gchar *dir, const gchar *text) {
  g_autoptr(GDir) entries = g_dir_open(dir, 0, NULL);
  g_assert_nonnull(entries);
  const gchar *name;
  while ((name = g_dir_read_name(entries)) != NULL) {
    g_autofree gchar *path = g_build_filename(dir, name, NULL);
    if (g_file_test(path, G_FILE_TEST_IS_DIR)) {
      if (tree_holds(path, text))
        return TRUE;
      continue;
    }
    g_autofree gchar *contents = NULL;
    gsize length;
    g_assert_true(g_file_get_contents(path, &contents, &length, NULL));
    gsize size = strlen(text);
    for (gsize at = 0; at + size <= length; at++)
      if (memcmp(contents + at, text, size) == 0)
        return TRUE;
  }
  return FALSE;
}

/* A repair that fails, here for a directory where it writes its new
 * manifest, moves the database aside, whole, and starts an empty one: none
 * is deleted. */
static void unrepairable(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  criticals_as_records();
  break_current();
  g_autofree gchar *manifest = in_userdb("000001.dbtmp");
  g_assert_cmpint(g_mkdir(manifest, 0755), ==, 0);

  golden_expect_log(G_LOG_LEVEL_CRITICAL,
                    "*Error opening db 'rime_ice': Corruption: *");
  golden_expect_log(G_LOG_LEVEL_CRITICAL, "*db recovery failed: *");
  golden_expect_log(G_LOG_LEVEL_WARNING,
                    "*moved db file '*rime_ice.userdb' aside to "
                    "*rime_ice.userdb.corrupt-*");
  golden_create(fixture, "rime:rime_ice");
  wait_redeployed(fixture);
  golden_assert_expected_logs();

  golden_type(fixture, "zhong");
  g_autofree gchar *first = first_candidate(fixture);
  g_assert_cmpstr(first, ==, "中");

  g_autoptr(GDir) entries = g_dir_open(home, 0, NULL);
  g_assert_nonnull(entries);
  g_autofree gchar *aside = NULL;
  const gchar *name;
  while ((name = g_dir_read_name(entries)) != NULL) {
    if (g_str_has_prefix(name, USERDB ".corrupt-")) {
      g_assert_null(aside);
      aside = g_build_filename(home, name, NULL);
    }
  }
  g_assert_nonnull(aside);
  g_assert_true(tree_holds(aside, "种"));
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
                             "learn, remember, io-error, repair, "
                             "unrepairable or compact",
                             "STEP"},
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

  if (g_str_equal(step, "learn")) {
    g_test_add("/rime-userdb/learn", Fixture, NULL, golden_setup, learn,
               golden_teardown);
    g_test_add("/rime-userdb/idle", Fixture, NULL, golden_setup, idle,
               golden_teardown);
    g_test_add("/rime-userdb/revert", Fixture, NULL, golden_setup, revert,
               golden_teardown);
  } else if (g_str_equal(step, "remember"))
    g_test_add("/rime-userdb/remember", Fixture, NULL, golden_setup, remembered,
               golden_teardown);
  else if (g_str_equal(step, "io-error"))
    g_test_add("/rime-userdb/io-error", Fixture, NULL, golden_setup, io_error,
               golden_teardown);
  else if (g_str_equal(step, "repair"))
    g_test_add("/rime-userdb/repair", Fixture, NULL, golden_setup, repaired,
               golden_teardown);
  else if (g_str_equal(step, "unrepairable"))
    g_test_add("/rime-userdb/unrepairable", Fixture, NULL, golden_setup,
               unrepairable, golden_teardown);
  else
    g_test_add("/rime-userdb/compaction", Fixture, NULL, golden_setup,
               compaction, golden_teardown);
  int result = g_test_run();
  g_free(step);
  return result;
}
