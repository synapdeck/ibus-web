/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later */
#include "variables.h"
#include "variable-table.h"
#include <gio/gio.h>
#include <m17n.h>
#include <stdint.h>
#include <string.h>

typedef enum { INTEGER, SYMBOL, TEXT } Type;

typedef struct {
  const gchar *language;
  const gchar *name;
  const gchar *schema;
  const gchar *key;
  Type type;
} Variable;

#define VARIABLE(language, name, schema, key, type)                            \
  {language, name, schema, key, type},
static const Variable variables[] = {IBUSWEB_M17N_VARIABLES(VARIABLE)};
#undef VARIABLE

/* m17n copies the configured values into each input context when it is made
 * and again when it is reset, so a value reaches contexts made afterwards and
 * an existing one at its next focus-out or reset; a composition under way
 * keeps the old value. The configuration is never saved: the page's settings
 * are its only store. */
static void configure(const Variable *variable, GSettings *settings) {
  g_autoptr(GVariant) value = g_settings_get_value(settings, variable->key);
  MPlist *plist = mplist();
  MText *text = NULL;
  const gchar *string = NULL;

  switch (variable->type) {
  case INTEGER:
    mplist_add(plist, Minteger, (void *)(intptr_t)g_variant_get_int32(value));
    break;
  case SYMBOL:
    mplist_add(plist, Msymbol, msymbol(g_variant_get_string(value, NULL)));
    break;
  case TEXT:
    string = g_variant_get_string(value, NULL);
    text = mconv_decode_buffer(Mcoding_utf_8, (const unsigned char *)string,
                               strlen(string));
    mplist_add(plist, Mtext, text);
    break;
  }

  if (minput_config_variable(msymbol(variable->language),
                             msymbol(variable->name), msymbol(variable->key),
                             plist) != 0)
    g_warning("m17n refused the value of %s:%s's variable %s",
              variable->language, variable->name, variable->key);

  if (text != NULL)
    m17n_object_unref(text);
  m17n_object_unref(plist);
}

static void changed(GSettings *settings, const gchar *key, gpointer data) {
  const gchar *schema = data;
  for (gsize i = 0; i < G_N_ELEMENTS(variables); i++)
    if (g_str_equal(variables[i].schema, schema) &&
        g_str_equal(variables[i].key, key))
      configure(&variables[i], settings);
}

void ibusweb_m17n_variables_init(void) {
  GSettings *settings = NULL;
  for (gsize i = 0; i < G_N_ELEMENTS(variables); i++) {
    /* A schema's variables are listed together. Its GSettings lives as long
     * as the module, which has no shutdown entry point. */
    if (i == 0 || !g_str_equal(variables[i].schema, variables[i - 1].schema)) {
      settings = g_settings_new(variables[i].schema);
      g_signal_connect(settings, "changed", G_CALLBACK(changed),
                       (gpointer)variables[i].schema);
    }
    configure(&variables[i], settings);
  }
}
