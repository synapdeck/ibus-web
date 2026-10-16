/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: GPL-3.0-or-later */
#include "harness.h"

static void committed(Fixture *fixture, const gchar *expected) {
  g_autofree gchar *text = golden_committed(fixture);
  g_assert_cmpstr(text, ==, expected);
}

static void preedit(Fixture *fixture, const gchar *expected) {
  g_autofree gchar *text = golden_preedit(fixture);
  g_assert_cmpstr(text, ==, expected);
}

/* The candidates on the latest table's page, without the empty one
 * ibus-rime appends to show there is a next page. */
static void candidates(Fixture *fixture, const gchar *const *expected,
                       guint page_size) {
  IBusLookupTable *table = IBUS_LOOKUP_TABLE(
      golden_object(golden_last(fixture, IBUSWEB_REC_UPDATE_LOOKUP_TABLE),
                    IBUS_TYPE_LOOKUP_TABLE));
  g_assert_cmpuint(ibus_lookup_table_get_page_size(table), ==, page_size);
  guint count = g_strv_length((gchar **)expected);
  g_assert_cmpuint(ibus_lookup_table_get_number_of_candidates(table), >=,
                   count);
  for (guint i = 0; i < count; i++)
    g_assert_cmpstr(ibus_lookup_table_get_candidate(table, i)->text, ==,
                    expected[i]);
  g_object_unref(table);
}

static gint key(Fixture *fixture, guint keyval, guint keycode) {
  return golden_key(fixture, keyval, keycode, 0);
}

static void escape(Fixture *fixture) {
  g_assert_cmpint(key(fixture, IBUS_Escape, 1), ==, 1);
  golden_clear(fixture);
}

static void activate(Fixture *fixture, const gchar *name, guint state) {
  g_assert_cmpint(golden_request(fixture, IBUSWEB_REQ_PROPERTY_ACTIVATE,
                                 g_variant_new("(su)", name, state)),
                  ==, 0);
}

/* The last UpdateProperty for key: its state and label. */
static void updated(Fixture *fixture, const gchar *key_name, guint state,
                    const gchar *label) {
  IBusProperty *found = NULL;
  for (guint i = 0; i < fixture->records->len; ++i) {
    Record *record = g_ptr_array_index(fixture->records, i);
    if (record->kind != IBUSWEB_REC_UPDATE_PROPERTY)
      continue;
    IBusProperty *prop =
        IBUS_PROPERTY(golden_object(record, IBUS_TYPE_PROPERTY));
    if (g_str_equal(ibus_property_get_key(prop), key_name)) {
      g_clear_object(&found);
      found = prop;
    } else {
      g_object_unref(prop);
    }
  }
  g_assert_nonnull(found);
  g_assert_cmpuint(ibus_property_get_state(found), ==, state);
  g_assert_cmpstr(ibus_property_get_label(found)->text, ==, label);
  g_object_unref(found);
}

static guint updates(Fixture *fixture, const gchar *key_name) {
  guint count = 0;
  for (guint i = 0; i < fixture->records->len; ++i) {
    Record *record = g_ptr_array_index(fixture->records, i);
    if (record->kind != IBUSWEB_REC_UPDATE_PROPERTY)
      continue;
    IBusProperty *prop =
        IBUS_PROPERTY(golden_object(record, IBUS_TYPE_PROPERTY));
    count += g_str_equal(ibus_property_get_key(prop), key_name);
    g_object_unref(prop);
  }
  return count;
}

/* A setting the module writes into Rime's YAML, which takes effect once
 * the deployment it starts has ended. */
static void deployed_setting(Fixture *fixture, const gchar *path,
                             const gchar *key_name, GVariant *value) {
  golden_clear(fixture);
  golden_setting(fixture, path, key_name, value);
  golden_wait_log(fixture, "Rime is ready.");
  golden_clear(fixture);
}

static void nihao(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "rime:rime_ice");
  golden_type(fixture, "nihao");
  preedit(fixture, "你好");
  candidates(fixture, (const gchar *[]){"你好", NULL}, 5);
  golden_type(fixture, " ");
  committed(fixture, "你好");
}

/* A corpus sentence, converted whole as the first candidate. The preview
 * shows it without committing, so nothing is learned. */
static void sentence(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "rime:rime_ice");
  golden_type(fixture,
              "tachengfeijiqulezhijiagezainaliouranyujianleyigepengyou");
  preedit(fixture, "他乘飞机去了芝加哥在那里偶然遇见了一个朋友");
  escape(fixture);
  committed(fixture, "");
}

/* rime-ice's Lua translators run: U and a code point types the character. */
static void lua(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "rime:rime_ice");
  golden_type(fixture, "U4e00");
  preedit(fixture, "一");
}

static void luna_pinyin(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "rime:luna_pinyin");
  golden_type(fixture, "hanzi");
  preedit(fixture, "漢字");
  escape(fixture);

  activate(fixture, "rime:option:simplification", PROP_STATE_CHECKED);
  updated(fixture, "rime:option:simplification", PROP_STATE_CHECKED, "汉字");
  golden_type(fixture, "hanzi");
  preedit(fixture, "汉字");
}

static void cangjie(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "rime:cangjie5");
  golden_type(fixture, "a");
  candidates(fixture, (const gchar *[]){"日", "曰", NULL}, 5);
  golden_type(fixture, " ");
  committed(fixture, "日");
}

/* Jyutping, with tones as comments, and its lookup by a character's two
 * parts, loengfan's, behind r. */
static void jyutping(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "rime:jyut6ping3");
  golden_type(fixture, "nei");
  candidates(fixture, (const gchar *[]){"你 nei5", "呢 nei1", NULL}, 5);
  escape(fixture);

  golden_type(fixture, "rmuk");
  preedit(fixture, "來");
}

static void wugniu(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "rime:wugniu");
  golden_type(fixture, "nonsa");
  candidates(fixture, (const gchar *[]){"農啥", "農", NULL}, 5);
}

/* combo_pinyin takes keys pressed together, on their release: e and r are
 * n's initial, i its final. Stenotype abbreviates: N is ni. */
static void chords(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "rime:combo_pinyin");
  golden_chord(fixture, "eri");
  preedit(fixture, "你");
  golden_destroy(fixture);

  golden_create(fixture, "rime:stenotype");
  golden_type(fixture, "N");
  preedit(fixture, "你");
}

/* PageDown shows the next page, and a click picks from the page shown. */
static void paging(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "rime:rime_ice");
  golden_type(fixture, "zhong");
  candidates(fixture, (const gchar *[]){"中", "🀄", "种", "重", "终", NULL}, 5);
  golden_empty_request(fixture, IBUSWEB_REQ_PAGE_DOWN);
  candidates(fixture, (const gchar *[]){"众", "钟", "忠", "仲", "衷", NULL}, 5);
  golden_clear(fixture);
  g_assert_cmpint(golden_request(fixture, IBUSWEB_REQ_CANDIDATE_CLICKED,
                                 g_variant_new("(uuu)", 1, 1, 0)),
                  ==, 0);
  committed(fixture, "钟");
}

/* Each switch is a property: two states a toggle, more a menu of radio
 * properties. */
static void properties(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_make(fixture, "rime:bopomofo");
  IBusPropList *props = IBUS_PROP_LIST(
      golden_object(golden_last(fixture, IBUSWEB_REC_REGISTER_PROPERTIES),
                    IBUS_TYPE_PROP_LIST));
  static const struct {
    const gchar *key;
    IBusPropType type;
    const gchar *label;
  } expected[] = {
      {"InputMode", PROP_TYPE_NORMAL, "中文"},
      {"deploy", PROP_TYPE_NORMAL, "部署"},
      {"sync", PROP_TYPE_NORMAL, "同步"},
      {"rime:option:ascii_mode", PROP_TYPE_TOGGLE, "中文"},
      {"rime:option:full_shape", PROP_TYPE_TOGGLE, "半角"},
      {"rime:options:2", PROP_TYPE_MENU, "傳統漢字"},
  };
  for (guint i = 0; i < G_N_ELEMENTS(expected); i++) {
    IBusProperty *prop = ibus_prop_list_get(props, i);
    g_assert_nonnull(prop);
    g_assert_cmpstr(ibus_property_get_key(prop), ==, expected[i].key);
    g_assert_cmpint(ibus_property_get_prop_type(prop), ==, expected[i].type);
    g_assert_cmpstr(ibus_property_get_label(prop)->text, ==, expected[i].label);
  }
  g_assert_null(ibus_prop_list_get(props, G_N_ELEMENTS(expected)));
  IBusPropList *options = ibus_property_get_sub_props(
      ibus_prop_list_get(props, G_N_ELEMENTS(expected) - 1));
  static const gchar *const option_keys[] = {
      "rime:option:zh_hant", "rime:option:zh_hans", "rime:option:zh_hant_tw"};
  for (guint i = 0; i < G_N_ELEMENTS(option_keys); i++) {
    IBusProperty *option = ibus_prop_list_get(options, i);
    g_assert_cmpstr(ibus_property_get_key(option), ==, option_keys[i]);
    g_assert_cmpint(ibus_property_get_prop_type(option), ==, PROP_TYPE_RADIO);
  }
  g_object_unref(props);
  golden_destroy(fixture);

  /* Choosing an option turns the group's others off and relabels the
   * menu. */
  golden_create(fixture, "rime:bopomofo");
  activate(fixture, "rime:option:zh_hans", PROP_STATE_CHECKED);
  updated(fixture, "rime:option:zh_hans", PROP_STATE_CHECKED, "简化字");
  updated(fixture, "rime:options:2", PROP_STATE_UNCHECKED, "简化字");
  golden_destroy(fixture);

  /* A toggle relabels itself, and its state reaches the conversion. */
  golden_create(fixture, "rime:rime_ice");
  activate(fixture, "rime:option:traditionalization", PROP_STATE_CHECKED);
  updated(fixture, "rime:option:traditionalization", PROP_STATE_CHECKED, "繁");
  golden_clear(fixture);
  golden_type(fixture, "hanzi");
  preedit(fixture, "漢字");
  escape(fixture);
  activate(fixture, "rime:option:traditionalization", PROP_STATE_UNCHECKED);
  updated(fixture, "rime:option:traditionalization", PROP_STATE_UNCHECKED,
          "简");
}

/* Rime's menu lists only the engine's own schema, then its options. */
static void switcher(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "rime:luna_pinyin");
  g_assert_cmpint(key(fixture, IBUS_F4, 62), ==, 1);
  IBusLookupTable *table = IBUS_LOOKUP_TABLE(
      golden_object(golden_last(fixture, IBUSWEB_REC_UPDATE_LOOKUP_TABLE),
                    IBUS_TYPE_LOOKUP_TABLE));
  g_assert_cmpuint(ibus_lookup_table_get_number_of_candidates(table), ==, 2);
  g_assert_cmpstr(ibus_lookup_table_get_candidate(table, 0)->text, ==,
                  "朙月拼音");
  g_assert_cmpstr(ibus_lookup_table_get_candidate(table, 1)->text, ==,
                  "中／半／漢／。");
  g_object_unref(table);
  escape(fixture);
}

/* Shift alone switches to Latin input and back, by default. */
static void ascii_mode(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "rime:rime_ice");
  g_assert_cmpint(key(fixture, IBUS_Shift_L, 42), ==, 0);
  updated(fixture, "rime:option:ascii_mode", PROP_STATE_CHECKED, "Ａ");
  golden_clear(fixture);
  g_assert_cmpint(key(fixture, IBUS_a, 30), ==, 0);
  g_assert_cmpint(key(fixture, IBUS_Shift_L, 42), ==, 0);
  updated(fixture, "rime:option:ascii_mode", PROP_STATE_UNCHECKED, "中");
}

/* A page-size change reaches an open context at its next key, with no
 * deployment. */
static void page_size(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "rime:rime_ice");
  golden_type(fixture, "shi");
  candidates(fixture, (const gchar *[]){NULL}, 5);
  escape(fixture);

  golden_clear(fixture);
  golden_setting(fixture, RIME_PATH, "page-size", g_variant_new_int32(7));
  golden_type(fixture, "shi");
  candidates(fixture, (const gchar *[]){NULL}, 7);
  g_assert_cmpuint(golden_count_log(fixture, "Rime is under maintenance ..."),
                   ==, 0);
  escape(fixture);

  golden_setting(fixture, RIME_PATH, "page-size", g_variant_new_int32(5));
}

static void no_switcher(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "rime:luna_pinyin");
  deployed_setting(fixture, RIME_PATH, "switcher-hotkeys",
                   g_variant_new_strv(NULL, 0));
  g_assert_cmpint(key(fixture, IBUS_F4, 62), ==, 0);
  g_assert_cmpuint(golden_count(fixture, IBUSWEB_REC_UPDATE_LOOKUP_TABLE), ==,
                   0);

  const gchar *defaults[] = {"Control+grave", "Control+Shift+grave", "F4"};
  deployed_setting(fixture, RIME_PATH, "switcher-hotkeys",
                   g_variant_new_strv(defaults, G_N_ELEMENTS(defaults)));
}

/* Presses key a second time. Caps Lock is on by then, which its press
 * carries as the lock modifier and its release no longer does. */
static void toggle_again(Fixture *fixture, guint keyval, guint keycode) {
  if (keyval != IBUS_Caps_Lock) {
    key(fixture, keyval, keycode);
    return;
  }
  golden_request(fixture, IBUSWEB_REQ_PROCESS_KEY_EVENT,
                 g_variant_new("(uuu)", keyval, keycode, IBUS_LOCK_MASK));
  golden_request(fixture, IBUSWEB_REQ_PROCESS_KEY_EVENT,
                 g_variant_new("(uuu)", keyval, keycode, IBUS_RELEASE_MASK));
}

/* Each choice of key switches to Latin input, and none does not. */
static void ascii_toggle_key(Fixture *fixture,
                             gconstpointer data G_GNUC_UNUSED) {
  static const struct {
    const gchar *choice;
    guint keyval, keycode;
  } choices[] = {
      {"control", IBUS_Control_L, 29},
      {"caps-lock", IBUS_Caps_Lock, 58},
      {"shift", IBUS_Shift_L, 42},
  };
  golden_create(fixture, "rime:rime_ice");
  for (guint i = 0; i < G_N_ELEMENTS(choices); i++) {
    deployed_setting(fixture, RIME_PATH, "ascii-toggle-key",
                     g_variant_new_string(choices[i].choice));
    key(fixture, choices[i].keyval, choices[i].keycode);
    updated(fixture, "rime:option:ascii_mode", PROP_STATE_CHECKED, "Ａ");
    golden_clear(fixture);
    toggle_again(fixture, choices[i].keyval, choices[i].keycode);
    updated(fixture, "rime:option:ascii_mode", PROP_STATE_UNCHECKED, "中");
  }

  deployed_setting(fixture, RIME_PATH, "ascii-toggle-key",
                   g_variant_new_string("none"));
  for (guint i = 0; i < G_N_ELEMENTS(choices); i++) {
    key(fixture, choices[i].keyval, choices[i].keycode);
    g_assert_cmpuint(updates(fixture, "rime:option:ascii_mode"), ==, 0);
  }
  deployed_setting(fixture, RIME_PATH, "ascii-toggle-key",
                   g_variant_new_string("shift"));
}

/* An engine's own settings set its switches' initial states. */
static void schema_settings(Fixture *fixture,
                            gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "rime:luna_pinyin");
  deployed_setting(fixture, RIME_SCHEMA_PATH("luna_pinyin"), "simplification",
                   g_variant_new_boolean(TRUE));
  golden_type(fixture, "hanzi");
  preedit(fixture, "汉字");
  escape(fixture);
  golden_destroy(fixture);

  /* rime-ice's engines start traditional. */
  golden_create(fixture, "rime:double_pinyin_flypy");
  deployed_setting(fixture, RIME_PATH, "traditional",
                   g_variant_new_boolean(TRUE));
  golden_type(fixture, "hjzi");
  preedit(fixture, "漢字");
  escape(fixture);

  deployed_setting(fixture, RIME_PATH, "traditional",
                   g_variant_new_boolean(FALSE));
  deployed_setting(fixture, RIME_SCHEMA_PATH("luna_pinyin"), "simplification",
                   g_variant_new_boolean(FALSE));
}

/* zh-z lets z stand for zh in rime-ice's Pinyin. */
static void fuzzy_pinyin(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "rime:rime_ice");
  golden_type(fixture, "zongguo");
  preedit(fixture, "总过");
  escape(fixture);

  const gchar *fuzzy[] = {"zh-z"};
  deployed_setting(fixture, RIME_PATH, "fuzzy-pinyin",
                   g_variant_new_strv(fuzzy, G_N_ELEMENTS(fuzzy)));
  golden_type(fixture, "zongguo");
  preedit(fixture, "中国");
  escape(fixture);

  deployed_setting(fixture, RIME_PATH, "fuzzy-pinyin",
                   g_variant_new_strv(NULL, 0));
}

/* Whether Shift alone switches the context to Latin input, as
 * ascii-toggle-key decides; it switches back if it did. A session made at
 * the key reports its switches' states first, so the last report counts. */
static gboolean shift_switches(Fixture *fixture) {
  golden_clear(fixture);
  key(fixture, IBUS_Shift_L, 42);
  gboolean switched = FALSE;
  for (guint i = 0; i < fixture->records->len; ++i) {
    Record *record = g_ptr_array_index(fixture->records, i);
    if (record->kind != IBUSWEB_REC_UPDATE_PROPERTY)
      continue;
    IBusProperty *prop =
        IBUS_PROPERTY(golden_object(record, IBUS_TYPE_PROPERTY));
    if (g_str_equal(ibus_property_get_key(prop), "rime:option:ascii_mode"))
      switched = ibus_property_get_state(prop) == PROP_STATE_CHECKED;
    g_object_unref(prop);
  }
  if (switched)
    key(fixture, IBUS_Shift_L, 42);
  golden_clear(fixture);
  return switched;
}

/* A deployment ends every session, and each engine then makes its own
 * again, though Rime may give a new session the id of one that ended. Each
 * engine types in its own schema whichever makes its session first, and
 * ending one leaves the other's composition. */
static void deployed_sessions(Fixture *fixture, gconstpointer data) {
  Fixture other = {0};
  golden_setup(&other, data);
  golden_create(fixture, "rime:luna_pinyin");
  golden_create(&other, "rime:cangjie5");

  deployed_setting(fixture, RIME_PATH, "ascii-toggle-key",
                   g_variant_new_string("caps-lock"));
  golden_type(&other, "a");
  candidates(&other, (const gchar *[]){"日", "曰", NULL}, 5);
  escape(&other);
  g_assert_false(shift_switches(&other));
  golden_type(fixture, "hanzi");
  preedit(fixture, "漢字");
  escape(fixture);

  deployed_setting(fixture, RIME_PATH, "ascii-toggle-key",
                   g_variant_new_string("shift"));
  golden_type(fixture, "hanzi");
  preedit(fixture, "漢字");
  escape(fixture);
  golden_type(&other, "a");
  candidates(&other, (const gchar *[]){"日", "曰", NULL}, 5);
  escape(&other);
  g_assert_true(shift_switches(&other));

  deployed_setting(fixture, RIME_PATH, "ascii-toggle-key",
                   g_variant_new_string("caps-lock"));
  golden_type(&other, "a");
  golden_destroy(fixture);
  golden_type(&other, " ");
  committed(&other, "日");

  deployed_setting(&other, RIME_PATH, "ascii-toggle-key",
                   g_variant_new_string("shift"));
  golden_teardown(&other, data);
}

/* A change during a deployment is deployed once that one has returned. */
static void back_to_back(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "rime:luna_pinyin");
  golden_clear(fixture);
  golden_setting(fixture, RIME_PATH, "ascii-toggle-key",
                 g_variant_new_string("caps-lock"));
  golden_setting(fixture, RIME_PATH, "ascii-toggle-key",
                 g_variant_new_string("shift"));
  g_assert_cmpuint(golden_count_log(fixture, "Rime is ready."), ==, 0);
  golden_wait_log(fixture, "Rime is ready.");
  golden_clear(fixture);
  golden_wait_log(fixture, "Rime is ready.");
  golden_clear(fixture);

  g_assert_true(shift_switches(fixture));
}

/* The Deploy property restarts Rime with a full check. During a
 * deployment, it restarts once that one has returned, and the restart's
 * deployment takes in a change made meanwhile. */
static void deploy(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "rime:luna_pinyin");
  golden_clear(fixture);
  activate(fixture, "deploy", PROP_STATE_UNCHECKED);
  golden_wait_log(fixture, "Rime is ready.");
  golden_clear(fixture);
  g_assert_true(shift_switches(fixture));

  golden_setting(fixture, RIME_PATH, "ascii-toggle-key",
                 g_variant_new_string("caps-lock"));
  g_assert_cmpuint(golden_count_log(fixture, "Rime is ready."), ==, 0);
  activate(fixture, "deploy", PROP_STATE_UNCHECKED);
  golden_setting(fixture, RIME_PATH, "ascii-toggle-key",
                 g_variant_new_string("shift"));
  golden_wait_log(fixture, "Rime is ready.");
  g_assert_cmpuint(golden_count_log(fixture, "Rime is under maintenance ..."),
                   ==, 2);
  golden_clear(fixture);

  g_assert_true(shift_switches(fixture));
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

  golden_init(schemas_dir, module, instances, "/engines/rime", NULL);
  g_free(schemas_dir);
  g_free(module);
  g_free(instances);
  g_option_context_free(context_options);

  g_test_add("/rime/nihao", Fixture, NULL, golden_setup, nihao,
             golden_teardown);
  g_test_add("/rime/sentence", Fixture, NULL, golden_setup, sentence,
             golden_teardown);
  g_test_add("/rime/lua", Fixture, NULL, golden_setup, lua, golden_teardown);
  g_test_add("/rime/luna-pinyin", Fixture, NULL, golden_setup, luna_pinyin,
             golden_teardown);
  g_test_add("/rime/cangjie", Fixture, NULL, golden_setup, cangjie,
             golden_teardown);
  g_test_add("/rime/jyutping", Fixture, NULL, golden_setup, jyutping,
             golden_teardown);
  g_test_add("/rime/wugniu", Fixture, NULL, golden_setup, wugniu,
             golden_teardown);
  g_test_add("/rime/chords", Fixture, NULL, golden_setup, chords,
             golden_teardown);
  g_test_add("/rime/paging", Fixture, NULL, golden_setup, paging,
             golden_teardown);
  g_test_add("/rime/properties", Fixture, NULL, golden_setup, properties,
             golden_teardown);
  g_test_add("/rime/switcher", Fixture, NULL, golden_setup, switcher,
             golden_teardown);
  g_test_add("/rime/ascii-mode", Fixture, NULL, golden_setup, ascii_mode,
             golden_teardown);
  g_test_add("/rime/page-size", Fixture, NULL, golden_setup, page_size,
             golden_teardown);
  g_test_add("/rime/no-switcher", Fixture, NULL, golden_setup, no_switcher,
             golden_teardown);
  g_test_add("/rime/ascii-toggle-key", Fixture, NULL, golden_setup,
             ascii_toggle_key, golden_teardown);
  g_test_add("/rime/schema-settings", Fixture, NULL, golden_setup,
             schema_settings, golden_teardown);
  g_test_add("/rime/fuzzy-pinyin", Fixture, NULL, golden_setup, fuzzy_pinyin,
             golden_teardown);
  g_test_add("/rime/deployed-sessions", Fixture, NULL, golden_setup,
             deployed_sessions, golden_teardown);
  g_test_add("/rime/back-to-back", Fixture, NULL, golden_setup, back_to_back,
             golden_teardown);
  g_test_add("/rime/deploy", Fixture, NULL, golden_setup, deploy,
             golden_teardown);
  return g_test_run();
}
