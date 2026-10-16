/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later */
#ifdef HAVE_CONFIG_H
#include "config.h"
#endif
#include "m17nutil.h"
#include <emscripten/wasmfs.h>
#include <stdio.h>
#include <sys/stat.h>

/* m17n reads its data from the store; nothing else of the host's is seen. */
backend_t wasmfs_create_root_dir(void) {
  return wasmfs_create_memory_backend();
}

static void string(GString *out, const gchar *value) {
  if (value == NULL) {
    g_string_append(out, "null");
    return;
  }
  g_string_append_c(out, '"');
  for (const gchar *p = value; *p != '\0'; p++) {
    guchar c = *p;
    if (c == '"' || c == '\\')
      g_string_append_printf(out, "\\%c", c);
    else if (c < 0x20)
      g_string_append_printf(out, "\\u%04x", c);
    else
      g_string_append_c(out, c);
  }
  g_string_append_c(out, '"');
}

static void text(GString *out, MText *mt) {
  g_autofree gchar *utf8 = ibus_m17n_mtext_to_utf8(mt);
  string(out, utf8);
}

/* One value of a variable: an integer, a symbol's name or a text. */
static void value(GString *out, MPlist *element) {
  MSymbol key = mplist_key(element);
  if (key == Minteger)
    g_string_append_printf(out, "%ld", (long)mplist_value(element));
  else if (key == Msymbol)
    string(out, msymbol_name(mplist_value(element)));
  else if (key == Mtext)
    text(out, mplist_value(element));
  else
    g_error("Unexpected variable value of type %s", msymbol_name(key));
}

static const gchar *type_name(MSymbol key) {
  if (key == Minteger)
    return "integer";
  if (key == Msymbol)
    return "symbol";
  if (key == Mtext)
    return "text";
  return NULL;
}

/* Each element is (NAME DESCRIPTION STATUS VALUE VALID-VALUE...); an integer
 * variable's valid value may be a (MIN MAX) range. */
static void variable(GString *out, MPlist *plist) {
  MSymbol name = mplist_value(plist);
  plist = mplist_next(plist);
  g_string_append(out, "{\"name\":");
  string(out, msymbol_name(name));
  g_string_append(out, ",\"description\":");
  if (mplist_key(plist) == Mtext)
    text(out, mplist_value(plist));
  else
    g_string_append(out, "null");
  plist = mplist_next(mplist_next(plist));

  g_string_append(out, ",\"type\":");
  string(out, type_name(mplist_key(plist)));
  g_string_append(out, ",\"value\":");
  if (type_name(mplist_key(plist)) != NULL)
    value(out, plist);
  else
    g_string_append(out, "null");

  g_string_append(out, ",\"valid\":[");
  gboolean first = TRUE;
  for (plist = mplist_next(plist); mplist_key(plist) != Mnil;
       plist = mplist_next(plist)) {
    if (!first)
      g_string_append_c(out, ',');
    first = FALSE;
    if (mplist_key(plist) == Mplist) {
      MPlist *range = mplist_value(plist);
      g_string_append(out, "{\"min\":");
      value(out, range);
      g_string_append(out, ",\"max\":");
      value(out, mplist_next(range));
      g_string_append_c(out, '}');
    } else {
      value(out, plist);
    }
  }
  g_string_append(out, "]}");
}

static void engine(GString *out, IBusEngineDesc *desc) {
  const gchar *name = ibus_engine_desc_get_name(desc);
  g_auto(GStrv) parts = g_strsplit(name, ":", 3);
  g_assert_cmpuint(g_strv_length(parts), ==, 3);

  g_string_append(out, "{\"name\":");
  string(out, name);
  g_string_append(out, ",\"language\":");
  string(out, ibus_engine_desc_get_language(desc));
  g_string_append(out, ",\"inputMethod\":");
  string(out, parts[2]);
  g_string_append_printf(
      out, ",\"rank\":%u,\"layout\":", ibus_engine_desc_get_rank(desc));
  string(out, ibus_engine_desc_get_layout(desc));

  g_string_append(out, ",\"variables\":[");
  MPlist *variables =
      minput_get_variable(msymbol(parts[1]), msymbol(parts[2]), Mnil);
  gboolean first = TRUE;
  for (MPlist *p = variables; p != NULL && mplist_key(p) != Mnil;
       p = mplist_next(p)) {
    if (!first)
      g_string_append_c(out, ',');
    first = FALSE;
    variable(out, mplist_value(p));
  }
  g_string_append(out, "]}");
}

/* Prints the engine list as the listing's index, IBus engine XML. Given a
 * directory, it lists the engines with that directory's default.xml and
 * index, as m17n.wasm does with its own. */
static int print_index(const char *pkgdatadir) {
  if (pkgdatadir != NULL) {
    g_assert_cmpint(
        wasmfs_create_directory("/pkgdata", 0777,
                                wasmfs_create_node_backend(pkgdatadir)),
        ==, 0);
    g_setenv("IBUS_M17N_PKGDATADIR", "/pkgdata", TRUE);
  }

  ibus_m17n_init_common();
  IBusComponent *component = g_object_ref_sink(ibus_m17n_get_component());
  GString *out = g_string_new(NULL);
  ibus_component_output_engines(component, out, 0);
  fputs(out->str, stdout);

  g_string_free(out, TRUE);
  g_object_unref(component);
  return 0;
}

int main(int argc, char **argv) {
  g_assert_cmpint(mkdir("/nix", 0777), ==, 0);
  g_assert_cmpint(
      wasmfs_create_directory("/nix/store", 0777,
                              wasmfs_create_node_backend("/nix/store")),
      ==, 0);

  if (argc > 1 && g_str_equal(argv[1], "--index"))
    return print_index(argc > 2 ? argv[2] : NULL);

  ibus_m17n_init_common();
  IBusComponent *component = g_object_ref_sink(ibus_m17n_get_component());
  GList *engines = ibus_component_get_engines(component);

  GString *out = g_string_new("[");
  for (GList *p = engines; p != NULL; p = p->next) {
    if (p != engines)
      g_string_append_c(out, ',');
    engine(out, p->data);
  }
  g_string_append(out, "]\n");
  fputs(out->str, stdout);

  g_string_free(out, TRUE);
  g_list_free(engines);
  g_object_unref(component);
  return 0;
}
