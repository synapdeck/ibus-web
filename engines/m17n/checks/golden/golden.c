/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later */
#include "harness.h"

/* The relocatable instances the cases change. */
static const gchar *const changed_paths[] = {M17N_PATH("hi", "inscript"),
                                             M17N_PATH("mr", "inscript")};

static void setup(Fixture *fixture, gconstpointer data) {
  golden_setup(fixture, data);
  for (guint i = 0; i < G_N_ELEMENTS(changed_paths); i++)
    golden_reset(fixture, changed_paths[i]);
  golden_setting(fixture, VARIABLES_PATH("vi", "telex"), "tone-mark-on-last",
                 g_variant_new_int32(1));
  golden_clear(fixture);
}

static void committed(Fixture *fixture, const gchar *expected) {
  g_autofree gchar *text = golden_committed(fixture);
  g_assert_cmpstr(text, ==, expected);
}

static void preedit(Fixture *fixture, const gchar *expected) {
  g_autofree gchar *text = golden_preedit(fixture);
  g_assert_cmpstr(text, ==, expected);
}

static void candidates(Fixture *fixture, const gchar *const *expected,
                       const gchar *page) {
  IBusLookupTable *table = IBUS_LOOKUP_TABLE(
      golden_object(golden_last(fixture, IBUSWEB_REC_UPDATE_LOOKUP_TABLE),
                    IBUS_TYPE_LOOKUP_TABLE));
  guint count = g_strv_length((gchar **)expected);
  g_assert_cmpuint(ibus_lookup_table_get_number_of_candidates(table), ==,
                   count);
  g_assert_cmpuint(ibus_lookup_table_get_page_size(table), ==, count);
  for (guint i = 0; i < count; i++)
    g_assert_cmpstr(ibus_lookup_table_get_candidate(table, i)->text, ==,
                    expected[i]);
  g_object_unref(table);

  IBusText *aux = IBUS_TEXT(golden_object(
      golden_last(fixture, IBUSWEB_REC_UPDATE_AUXILIARY_TEXT), IBUS_TYPE_TEXT));
  g_assert_cmpstr(aux->text, ==, page);
  g_object_unref(aux);
}

/* ibus-m17n's constructor opens the input method and draws its preedit and
 * status before CreateEngine returns. */
static void context(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_make(fixture, "m17n:t:latn-pre");
  g_assert_cmpuint(golden_count(fixture, IBUSWEB_REC_HIDE_PREEDIT_TEXT), ==, 2);
  g_assert_cmpuint(golden_count(fixture, IBUSWEB_REC_UPDATE_PROPERTY), ==, 1);
}

static void latin_postfix(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "m17n:t:latn-post");
  golden_type(fixture, "a");
  preedit(fixture, "a");
  golden_type(fixture, "'");
  preedit(fixture, "á");
  committed(fixture, "");
  golden_type(fixture, " ");
  committed(fixture, "á ");
  preedit(fixture, "");
}

static void inscript(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "m17n:hi:inscript");
  golden_type(fixture, "k");
  committed(fixture, "क");
  golden_clear(fixture);
  golden_type(fixture, "d");
  committed(fixture, "");
  preedit(fixture, "्");
}

static void telex(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "m17n:vi:telex");
  golden_type(fixture, "vieetj");
  committed(fixture, "v");
  preedit(fixture, "iệt");
  golden_clear(fixture);
  golden_type(fixture, " ");
  committed(fixture, "iệt ");
  preedit(fixture, "");
}

/* Kesmanee checks each key against the text before the cursor, which it
 * reads through surrounding text, and replaces a tone mark that can't
 * follow another by deleting the one before it. */
static void thai_surrounding(Fixture *fixture,
                             gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "m17n:th:kesmanee");
  golden_surrounding(fixture, "ก", 1);
  golden_clear(fixture);
  golden_type(fixture, "h");
  g_assert_cmpuint(golden_count(fixture, IBUSWEB_REC_REQUIRE_SURROUNDING_TEXT),
                   >, 0);
  g_assert_cmpuint(golden_count(fixture, IBUSWEB_REC_DELETE_SURROUNDING_TEXT),
                   ==, 0);
  committed(fixture, "้");
  golden_destroy(fixture);

  golden_create(fixture, "m17n:th:kesmanee");
  golden_surrounding(fixture, "ก่", 2);
  golden_clear(fixture);
  golden_type(fixture, "h");
  gint offset;
  guint length;
  g_variant_get(
      golden_last(fixture, IBUSWEB_REC_DELETE_SURROUNDING_TEXT)->payload,
      "(iu)", &offset, &length);
  g_assert_cmpint(offset, ==, -1);
  g_assert_cmpuint(length, ==, 1);
  g_assert_cmpint(golden_index(fixture, IBUSWEB_REC_DELETE_SURROUNDING_TEXT), <,
                  golden_index(fixture, IBUSWEB_REC_COMMIT_TEXT));
  committed(fixture, "้");
}

static void cangjie(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "m17n:zh:cangjie");
  golden_type(fixture, "a");
  preedit(fixture, "日");
  candidates(fixture, (const gchar *[]){"日", "曰", NULL}, "( 1 / 1 )");
  golden_type(fixture, " ");
  committed(fixture, "日");
}

/* With AltGr, the keyval is whatever the user's layout gave; ibus-m17n
 * asks the US keymap for the key's unshifted keysym and adds G-. */
static void altgr(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "m17n:hi:inscript");
  g_assert_cmpint(golden_key(fixture, IBUS_currency, 5, IBUS_MOD5_MASK), ==, 1);
  committed(fixture, "₹");
}

static void us_layout(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "m17n:hi:inscript");
  golden_setting(fixture, M17N_PATH("hi", "inscript"), "use-us-layout",
                 g_variant_new_boolean(TRUE));
  g_assert_cmpint(golden_key(fixture, IBUS_x, 37, 0), ==, 1);
  committed(fixture, "क");
  golden_clear(fixture);

  golden_setting(fixture, M17N_PATH("hi", "inscript"), "use-us-layout",
                 g_variant_new_boolean(FALSE));
  g_assert_cmpint(golden_key(fixture, IBUS_x, 37, 0), ==, 1);
  committed(fixture, "ं");
}

/* One relocatable schema, an instance per engine: Hindi's setting leaves
 * Marathi's alone. */
static void settings_apart(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_setting(fixture, M17N_PATH("hi", "inscript"), "use-us-layout",
                 g_variant_new_boolean(TRUE));
  golden_create(fixture, "m17n:mr:inscript");
  g_assert_cmpint(golden_key(fixture, IBUS_x, 37, 0), ==, 1);
  committed(fixture, "ं");
  golden_destroy(fixture);

  golden_create(fixture, "m17n:hi:inscript");
  g_assert_cmpint(golden_key(fixture, IBUS_x, 37, 0), ==, 1);
  committed(fixture, "क");
}

/* candidates-group-size is 2 from Init, so 瀛's six candidates take three
 * pages. */
static void cangjie_paging(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "m17n:zh:cangjie");
  golden_type(fixture, "eyrn");
  preedit(fixture, "瀛");
  candidates(fixture, (const gchar *[]){"瀛", "渟", NULL}, "( 1 / 3 )");

  golden_empty_request(fixture, IBUSWEB_REQ_PAGE_DOWN);
  preedit(fixture, "涥");
  candidates(fixture, (const gchar *[]){"涥", "灜", NULL}, "( 2 / 3 )");
  golden_empty_request(fixture, IBUSWEB_REQ_PAGE_UP);
  preedit(fixture, "瀛");
  candidates(fixture, (const gchar *[]){"瀛", "渟", NULL}, "( 1 / 3 )");
  golden_empty_request(fixture, IBUSWEB_REQ_PAGE_DOWN);

  golden_clear(fixture);
  golden_type(fixture, " ");
  committed(fixture, "涥");
}

/* tone-mark-on-last is 1 for Telex from Init and 0, its default, for VNI:
 * an equivocal "oa" takes its tone on the last vowel only in Telex. */
static void variable_from_init(Fixture *fixture,
                               gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "m17n:vi:telex");
  golden_type(fixture, "hoaf ");
  committed(fixture, "hoà ");
  golden_destroy(fixture);

  golden_create(fixture, "m17n:vi:vni");
  golden_type(fixture, "hoa2 ");
  committed(fixture, "hòa ");
}

/* A change reaches every context made afterwards, including those of an
 * input method that is already open, and VIQR was never open before this
 * case. */
static void variable_changed(Fixture *fixture,
                             gconstpointer data G_GNUC_UNUSED) {
  golden_setting(fixture, VARIABLES_PATH("vi", "viqr"), "tone-mark-on-last",
                 g_variant_new_int32(1));
  golden_create(fixture, "m17n:vi:viqr");
  golden_type(fixture, "hoa` ");
  committed(fixture, "hoà ");
}

/* The input method is open, with a live context, when the value changes; a
 * context made afterwards still gets the new one. */
static void variable_to_new_context(Fixture *fixture,
                                    gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "m17n:vi:telex");
  guint32 first_ic = fixture->ic;
  IBusEngine *first_engine = fixture->engine;

  golden_setting(fixture, VARIABLES_PATH("vi", "telex"), "tone-mark-on-last",
                 g_variant_new_int32(0));
  golden_create(fixture, "m17n:vi:telex");
  golden_type(fixture, "hoaf ");
  committed(fixture, "hòa ");
  golden_destroy(fixture);

  fixture->ic = first_ic;
  fixture->engine = first_engine;
}

/* A context copies the input method's variables when it is made and again
 * when it is reset, which focus-out does, so the change waits for that. */
static void variable_to_existing_context(Fixture *fixture,
                                         gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "m17n:vi:telex");
  golden_setting(fixture, VARIABLES_PATH("vi", "telex"), "tone-mark-on-last",
                 g_variant_new_int32(0));
  golden_type(fixture, "hoaf ");
  committed(fixture, "hoà ");
  golden_clear(fixture);

  golden_empty_request(fixture, IBUSWEB_REQ_FOCUS_OUT);
  golden_empty_request(fixture, IBUSWEB_REQ_FOCUS_IN);
  golden_clear(fixture);
  golden_type(fixture, "hoaf ");
  committed(fixture, "hòa ");
  golden_clear(fixture);

  golden_setting(fixture, VARIABLES_PATH("vi", "telex"), "tone-mark-on-last",
                 g_variant_new_int32(1));
  golden_type(fixture, "hoaf ");
  committed(fixture, "hòa ");
  golden_clear(fixture);

  golden_empty_request(fixture, IBUSWEB_REQ_RESET);
  golden_type(fixture, "hoaf ");
  committed(fixture, "hoà ");
}

int main(int argc, char **argv) {
  g_test_init(&argc, &argv, NULL);
  gchar *schemas_dir = NULL, *module = NULL, *instances = NULL;
  GOptionEntry options[] = {{"schemas", 0, 0, G_OPTION_ARG_STRING, &schemas_dir,
                             "Compiled GSettings schemas directory", "DIR"},
                            {"module", 0, 0, G_OPTION_ARG_FILENAME, &module,
                             "Engine side module", "FILE"},
                            {"instances", 0, 0, G_OPTION_ARG_FILENAME,
                             &instances, "The module's settings instances",
                             "FILE"},
                            {NULL}};
  GOptionContext *context_options = g_option_context_new(NULL);
  g_option_context_add_main_entries(context_options, options, NULL);
  GError *error = NULL;
  g_assert_true(g_option_context_parse(context_options, &argc, &argv, &error));
  g_assert_no_error(error);
  g_assert_nonnull(schemas_dir);
  g_assert_nonnull(module);
  g_assert_nonnull(instances);

  const GoldenSeed seeds[] = {
      {VARIABLES_PATH("vi", "telex"), "tone-mark-on-last",
       g_variant_new_int32(1)},
      {VARIABLES_PATH("zh", "cangjie"), "candidates-group-size",
       g_variant_new_int32(2)},
  };
  golden_init(schemas_dir, module, instances, seeds, G_N_ELEMENTS(seeds));
  g_free(schemas_dir);
  g_free(module);
  g_free(instances);
  g_option_context_free(context_options);

  g_test_add("/m17n/context", Fixture, NULL, setup, context, golden_teardown);
  g_test_add("/m17n/latin-postfix", Fixture, NULL, setup, latin_postfix,
             golden_teardown);
  g_test_add("/m17n/inscript", Fixture, NULL, setup, inscript, golden_teardown);
  g_test_add("/m17n/telex", Fixture, NULL, setup, telex, golden_teardown);
  g_test_add("/m17n/thai-surrounding", Fixture, NULL, setup, thai_surrounding,
             golden_teardown);
  g_test_add("/m17n/cangjie", Fixture, NULL, setup, cangjie, golden_teardown);
  g_test_add("/m17n/altgr", Fixture, NULL, setup, altgr, golden_teardown);
  g_test_add("/m17n/us-layout", Fixture, NULL, setup, us_layout,
             golden_teardown);
  g_test_add("/m17n/settings-apart", Fixture, NULL, setup, settings_apart,
             golden_teardown);
  g_test_add("/m17n/cangjie-paging", Fixture, NULL, setup, cangjie_paging,
             golden_teardown);
  g_test_add("/m17n/variable-from-init", Fixture, NULL, setup,
             variable_from_init, golden_teardown);
  g_test_add("/m17n/variable-changed", Fixture, NULL, setup, variable_changed,
             golden_teardown);
  g_test_add("/m17n/variable-to-new-context", Fixture, NULL, setup,
             variable_to_new_context, golden_teardown);
  g_test_add("/m17n/variable-to-existing-context", Fixture, NULL, setup,
             variable_to_existing_context, golden_teardown);
  return g_test_run();
}
