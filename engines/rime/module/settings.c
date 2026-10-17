/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: GPL-3.0-or-later */
#include "settings.h"
#include "rime-tables.h"
#include <errno.h>
#include <gio/gio.h>
#include <glib/gstdio.h>
#include <ibus-web/runtime.h>

#define RIME_SCHEMA "org.freedesktop.ibus.engine.rime"
#define RIME_SCHEMA_SCHEMA RIME_SCHEMA ".schema"
#define RIME_PATH "/org/freedesktop/ibus/engine/rime/"

typedef struct {
  const char *schema;
  const char *name;
  int index;
  int option;
} Switch;

typedef struct {
  const char *schema;
  const char *rule;
} AlgebraRule;

#define IBUSWEB_RIME_SCHEMA_ENTRY(schema_id) schema_id,
static const char *const schemas[] = {
    IBUSWEB_RIME_SCHEMAS(IBUSWEB_RIME_SCHEMA_ENTRY)};
#undef IBUSWEB_RIME_SCHEMA_ENTRY

#define IBUSWEB_RIME_SWITCH_ENTRY(schema_id, name, index, option)              \
  {schema_id, name, index, option},
static const Switch switches[] = {
    IBUSWEB_RIME_SWITCHES(IBUSWEB_RIME_SWITCH_ENTRY)};
#undef IBUSWEB_RIME_SWITCH_ENTRY

#define IBUSWEB_RIME_ALGEBRA_ENTRY(schema_id, rule) {schema_id, rule},
static const AlgebraRule algebra[] = {
    IBUSWEB_RIME_ALGEBRA(IBUSWEB_RIME_ALGEBRA_ENTRY)};
#undef IBUSWEB_RIME_ALGEBRA_ENTRY

/* rime-ice's fuzzy pinyin, the rules its speller carries commented out, by
 * the names the settings schema offers. */
static const struct {
  const char *name;
  const char *rule;
} fuzzy_rules[] = {
    {"zh-z", "derive/^([zcs])h/$1/"},
    {"z-zh", "derive/^([zcs])([^h])/$1h$2/"},
    {"l-n", "derive/^l/n/"},
    {"n-l", "derive/^n/l/"},
    {"f-h", "derive/^f/h/"},
    {"h-f", "derive/^h/f/"},
    {"l-r", "derive/^l/r/"},
    {"r-l", "derive/^r/l/"},
    {"g-k", "derive/^g/k/"},
    {"k-g", "derive/^k/g/"},
    {"ang-an", "derive/ang$/an/"},
    {"an-ang", "derive/an$/ang/"},
    {"eng-en", "derive/eng$/en/"},
    {"en-eng", "derive/en$/eng/"},
    {"in-ing", "derive/in$/ing/"},
    {"ing-in", "derive/ing$/in/"},
    {"ian-iang", "derive/ian$/iang/"},
    {"iang-ian", "derive/iang$/ian/"},
    {"uan-uang", "derive/uan$/uang/"},
    {"uang-uan", "derive/uang$/uan/"},
    {"ai-an", "derive/ai$/an/"},
    {"an-ai", "derive/an$/ai/"},
    {"ong-un", "derive/ong$/un/"},
    {"un-ong", "derive/un$/ong/"},
    {"ong-on", "derive/ong$/on/"},
    {"iong-un", "derive/iong$/un/"},
    {"un-iong", "derive/un$/iong/"},
    {"ong-eng", "derive/ong$/eng/"},
    {"eng-ong", "derive/eng$/ong/"},
    {"fei-hui", "derive/^fei$/hui/"},
    {"hui-fei", "derive/^hui$/fei/"},
    {"hu-fu", "derive/^hu$/fu/"},
    {"fu-hu", "derive/^fu$/hu/"},
    {"wang-huang", "derive/^wang$/huang/"},
    {"huang-wang", "derive/^huang$/wang/"},
};

/* Rime's ascii_composer actions for each choice of ascii-toggle-key. shift
 * is the default configuration's own: either Shift switches, as does Caps
 * Lock, which also clears the composition. */
static const struct {
  const char *name;
  const char *keys;
} ascii_toggle_keys[] = {
    {"shift", "    Shift_L: inline_ascii\n"
              "    Shift_R: commit_text\n"
              "    Control_L: noop\n"
              "    Control_R: noop\n"
              "    Caps_Lock: clear\n"
              "    Eisu_toggle: clear\n"},
    {"caps-lock", "    Shift_L: noop\n"
                  "    Shift_R: noop\n"
                  "    Control_L: noop\n"
                  "    Control_R: noop\n"
                  "    Caps_Lock: clear\n"
                  "    Eisu_toggle: clear\n"},
    {"control", "    Shift_L: noop\n"
                "    Shift_R: noop\n"
                "    Control_L: commit_code\n"
                "    Control_R: commit_code\n"
                "    Caps_Lock: noop\n"
                "    Eisu_toggle: noop\n"},
    {"none", "    Shift_L: noop\n"
             "    Shift_R: noop\n"
             "    Control_L: noop\n"
             "    Control_R: noop\n"
             "    Caps_Lock: noop\n"
             "    Eisu_toggle: noop\n"},
};

static GSettings *settings;
static GSettings *schema_settings[G_N_ELEMENTS(schemas)];

/* Whether a change came while a deployment ran, which is compiled once it
 * has returned. */
static gboolean pending;

/* A YAML double-quoted scalar. */
static void append_quoted(GString *yaml, const char *text) {
  g_string_append_c(yaml, '"');
  for (const char *c = text; *c != '\0'; c++) {
    if (*c == '"' || *c == '\\')
      g_string_append_c(yaml, '\\');
    g_string_append_c(yaml, *c);
  }
  g_string_append_c(yaml, '"');
}

/* The value the page stored for key, or NULL: only those are patched, so
 * a key left at its default leaves Rime's own configuration alone. */
static GVariant *stored(GSettings *from, const char *key) {
  return g_settings_get_user_value(from, key);
}

/* The page size is no part of it: the module sets it on each session's
 * schema. */
static char *default_patch(void) {
  GString *yaml = g_string_new(NULL);
  GVariant *value;

  if ((value = stored(settings, "switcher-hotkeys")) != NULL) {
    g_autofree const char **keys = g_variant_get_strv(value, NULL);
    g_string_append(yaml, "  \"switcher/hotkeys\":");
    if (keys[0] == NULL)
      g_string_append(yaml, " []");
    g_string_append_c(yaml, '\n');
    for (const char **key = keys; *key != NULL; key++) {
      g_string_append(yaml, "    - ");
      append_quoted(yaml, *key);
      g_string_append_c(yaml, '\n');
    }
    g_variant_unref(value);
  }

  if ((value = stored(settings, "ascii-toggle-key")) != NULL) {
    const char *choice = g_variant_get_string(value, NULL);
    for (gsize i = 0; i < G_N_ELEMENTS(ascii_toggle_keys); i++) {
      if (g_str_equal(choice, ascii_toggle_keys[i].name))
        g_string_append_printf(yaml, "  \"ascii_composer/switch_key\":\n%s",
                               ascii_toggle_keys[i].keys);
    }
    g_variant_unref(value);
  }

  return g_string_free(yaml, FALSE);
}

static char *ibus_rime_patch(void) {
  GString *yaml = g_string_new(NULL);
  GVariant *value;

  if ((value = stored(settings, "inline-preedit")) != NULL) {
    g_string_append_printf(yaml, "  \"style/inline_preedit\": %s\n",
                           g_variant_get_boolean(value) ? "true" : "false");
    g_variant_unref(value);
  }

  static const struct {
    const char *key;
    const char *path;
  } strings[] = {{"preedit-style", "style/preedit_style"},
                 {"cursor-type", "style/cursor_type"}};
  for (gsize i = 0; i < G_N_ELEMENTS(strings); i++) {
    if ((value = stored(settings, strings[i].key)) == NULL)
      continue;
    g_string_append_printf(yaml, "  \"%s\": ", strings[i].path);
    append_quoted(yaml, g_variant_get_string(value, NULL));
    g_string_append_c(yaml, '\n');
    g_variant_unref(value);
  }

  return g_string_free(yaml, FALSE);
}

/* A switch's initial state: the option's index for a switch of several
 * options, which only true sets, or 0 or 1 for a toggle. */
static void append_reset(GString *yaml, const Switch *found, gboolean on) {
  if (found->option < 0)
    g_string_append_printf(yaml, "  \"switches/@%d/reset\": %d\n", found->index,
                           on ? 1 : 0);
  else if (on)
    g_string_append_printf(yaml, "  \"switches/@%d/reset\": %d\n", found->index,
                           found->option);
}

static char *schema_patch(gsize index) {
  const char *schema_id = schemas[index];
  GSettings *own = schema_settings[index];
  GString *yaml = g_string_new(NULL);

  static const struct {
    const char *key;
    const char *name;
  } resets[] = {{"full-shape", "full_shape"},
                {"ascii-punct", "ascii_punct"},
                {"simplification", "simplification"}};
  for (gsize i = 0; i < G_N_ELEMENTS(switches); i++) {
    const Switch *found = &switches[i];
    if (!g_str_equal(found->schema, schema_id))
      continue;
    GVariant *value = NULL;
    if (g_str_equal(found->name, "traditionalization")) {
      value = stored(settings, "traditional");
    } else {
      for (gsize j = 0; j < G_N_ELEMENTS(resets); j++) {
        if (g_str_equal(found->name, resets[j].name))
          value = stored(own, resets[j].key);
      }
    }
    if (value == NULL)
      continue;
    append_reset(yaml, found, g_variant_get_boolean(value));
    g_variant_unref(value);
  }

  GVariant *fuzzy = stored(settings, "fuzzy-pinyin");
  gboolean pinyin = FALSE;
  for (gsize i = 0; i < G_N_ELEMENTS(algebra); i++)
    pinyin |= g_str_equal(algebra[i].schema, schema_id);
  if (fuzzy != NULL && pinyin) {
    /* The rules derive from the full spellings, so they go before the
     * rest of the algebra, which double pinyin's begins converting. */
    g_autofree const char **names = g_variant_get_strv(fuzzy, NULL);
    g_string_append(yaml, "  \"speller/algebra\":\n");
    for (const char **name = names; *name != NULL; name++) {
      for (gsize i = 0; i < G_N_ELEMENTS(fuzzy_rules); i++) {
        if (!g_str_equal(*name, fuzzy_rules[i].name))
          continue;
        g_string_append(yaml, "    - ");
        append_quoted(yaml, fuzzy_rules[i].rule);
        g_string_append_c(yaml, '\n');
      }
    }
    for (gsize i = 0; i < G_N_ELEMENTS(algebra); i++) {
      if (!g_str_equal(algebra[i].schema, schema_id))
        continue;
      g_string_append(yaml, "    - ");
      append_quoted(yaml, algebra[i].rule);
      g_string_append_c(yaml, '\n');
    }
  }
  g_clear_pointer(&fuzzy, g_variant_unref);

  return g_string_free(yaml, FALSE);
}

/* Writes name's patch, or removes the file when there's nothing to patch,
 * and says whether that changed it. */
static gboolean write_patch(const char *name, char *patch) {
  g_autofree char *path = g_build_filename(g_get_home_dir(), name, NULL);
  g_autofree char *contents =
      *patch == '\0' ? NULL : g_strconcat("patch:\n", patch, NULL);
  g_free(patch);

  g_autofree char *existing = NULL;
  if (!g_file_get_contents(path, &existing, NULL, NULL))
    existing = NULL;
  if (g_strcmp0(existing, contents) == 0)
    return FALSE;

  g_autoptr(GError) error = NULL;
  if (contents == NULL) {
    if (g_unlink(path) != 0)
      g_warning("%s: %s", path, g_strerror(errno));
  } else if (!g_file_set_contents(path, contents, -1, &error)) {
    g_warning("%s", error->message);
  }
  return TRUE;
}

static gboolean write_patches(void) {
  gboolean changed = write_patch("default.custom.yaml", default_patch());
  changed |= write_patch("ibus_rime.custom.yaml", ibus_rime_patch());
  for (gsize i = 0; i < G_N_ELEMENTS(schemas); i++) {
    g_autofree char *name = g_strconcat(schemas[i], ".custom.yaml", NULL);
    changed |= write_patch(name, schema_patch(i));
  }
  return changed;
}

static char *checksum(const char *defaults, const char *own) {
  g_autoptr(GChecksum) sum = g_checksum_new(G_CHECKSUM_SHA256);
  g_checksum_update(sum, (const guchar *)defaults, -1);
  g_checksum_update(sum, (const guchar *)"", 1);
  g_checksum_update(sum, (const guchar *)own, -1);
  return g_strdup(g_checksum_get_string(sum));
}

char *ibusweb_rime_fingerprint(const char *id) {
  if (g_str_equal(id, "ibus_rime")) {
    g_autofree char *own = ibus_rime_patch();
    return checksum("", own);
  }

  g_autofree char *defaults = default_patch();
  for (gsize i = 0; i < G_N_ELEMENTS(schemas); i++) {
    if (g_str_equal(schemas[i], id)) {
      g_autofree char *own = schema_patch(i);
      return checksum(defaults, own);
    }
  }
  return checksum(defaults, "");
}

char *ibusweb_rime_prebuilt_fingerprint(void) { return checksum("", ""); }

int ibusweb_rime_page_size(void) {
  g_autoptr(GVariant) value = stored(settings, "page-size");
  return value != NULL ? g_variant_get_int32(value) : 0;
}

static void changed(GSettings *from, const char *key,
                    gpointer data G_GNUC_UNUSED) {
  if (from == settings && g_str_equal(key, "page-size"))
    ibusweb_rime_page_size_changed();
  if (!ibusweb_user_data_writable() || !write_patches())
    return;
  if (ibusweb_rime_deploying())
    pending = TRUE;
  else
    ibusweb_rime_compile_open();
}

/* The patches and what they compile are the writer's, in the user directory a
 * read-only module can't change. A read-only module still reads the settings:
 * the page size, which no patch carries, and the fingerprints of what the
 * writer compiled. */
void ibusweb_rime_settings_init(void) {
  settings = g_settings_new(RIME_SCHEMA);
  g_signal_connect(settings, "changed", G_CALLBACK(changed), NULL);
  for (gsize i = 0; i < G_N_ELEMENTS(schemas); i++) {
    g_autofree char *path = g_strconcat(RIME_PATH, schemas[i], "/", NULL);
    schema_settings[i] = g_settings_new_with_path(RIME_SCHEMA_SCHEMA, path);
    g_signal_connect(schema_settings[i], "changed", G_CALLBACK(changed), NULL);
  }
  if (ibusweb_user_data_writable())
    write_patches();
}

void ibusweb_rime_settings_deployed(void) {
  if (!pending)
    return;
  pending = FALSE;

  if (!ibusweb_rime_deploying())
    ibusweb_rime_compile_open();
}
