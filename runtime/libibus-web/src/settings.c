/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */
#define G_SETTINGS_ENABLE_BACKEND
#include "settings.h"
#include "output.h"
#include <errno.h>
#include <gio/gio.h>
#include <gio/gsettingsbackend.h>
#include <ibus-web/protocol.h>
#include <string.h>

typedef struct {
  GSettingsBackend parent;
  GMutex lock;
  /* Full key paths to values; a missing value has the schema's default. */
  GHashTable *values;
  /* Instance paths to their schemas, as Init declared them, and as patterns
   * matched them since. */
  GHashTable *instances;
  /* Relocatable schemas declared by path pattern, in Init's order. */
  GPtrArray *patterns;
} IBusWebSettingsBackend;

typedef struct {
  gchar *pattern;
  GSettingsSchema *schema;
} Pattern;

static void pattern_free(gpointer data) {
  Pattern *pattern = data;
  g_free(pattern->pattern);
  g_settings_schema_unref(pattern->schema);
  g_free(pattern);
}
typedef struct {
  GSettingsBackendClass parent;
} IBusWebSettingsBackendClass;
G_DEFINE_TYPE(IBusWebSettingsBackend, ibusweb_settings_backend,
              G_TYPE_SETTINGS_BACKEND)

typedef struct {
  gchar *instance;
  gchar *name;
  gchar *path;
  GSettingsSchemaKey *definition;
} SettingKey;

static void key_free(gpointer data) {
  SettingKey *key = data;
  g_free(key->instance);
  g_free(key->name);
  g_free(key->path);
  g_settings_schema_key_unref(key->definition);
  g_free(key);
}
G_DEFINE_AUTOPTR_CLEANUP_FUNC(SettingKey, key_free)

static SettingKey *key_new(GSettingsSchema *schema, const gchar *instance,
                           const gchar *name) {
  SettingKey *key = g_new(SettingKey, 1);
  key->instance = g_strdup(instance);
  key->name = g_strdup(name);
  key->path = g_strconcat(instance, name, NULL);
  key->definition = g_settings_schema_get_key(schema, name);
  return key;
}

/* GSettings' own rule for a path: absolute, a directory, no empty
 * component. */
static gboolean path_valid(const gchar *path) {
  return path[0] == '/' && g_str_has_suffix(path, "/") &&
         strstr(path, "//") == NULL;
}

static GSettingsSchema *lookup_schema(const gchar *id) {
  GSettingsSchemaSource *source = g_settings_schema_source_get_default();
  GSettingsSchema *schema =
      source == NULL ? NULL : g_settings_schema_source_lookup(source, id, TRUE);
  if (schema == NULL)
    g_warning("Unknown settings schema: %s", id);
  return schema;
}

/* A pattern is a valid path whose {name} placeholders, of letters, digits,
 * '-' and '_', each stand for one or more characters other than '/'. */
static gboolean pattern_valid(const gchar *pattern) {
  if (!path_valid(pattern))
    return FALSE;

  gboolean placeholder = FALSE;
  for (const gchar *at = pattern; *at != '\0'; at++) {
    if (*at == '}')
      return FALSE;
    if (*at != '{')
      continue;

    const gchar *name = ++at;
    while (g_ascii_isalnum(*at) || *at == '-' || *at == '_')
      at++;
    if (at == name || *at != '}')
      return FALSE;
    placeholder = TRUE;
  }
  return placeholder;
}

static gboolean pattern_matches(const gchar *pattern, const gchar *path) {
  if (*pattern == '\0')
    return *path == '\0';

  if (*pattern != '{')
    return *pattern == *path && pattern_matches(pattern + 1, path + 1);

  const gchar *rest = strchr(pattern, '}') + 1;
  for (const gchar *end = path + 1; end[-1] != '\0' && end[-1] != '/'; end++)
    if (pattern_matches(rest, end))
      return TRUE;
  return FALSE;
}

static void declare_pattern(IBusWebSettingsBackend *backend, const gchar *id,
                            const gchar *pattern) {
  g_autoptr(GSettingsSchema) schema = lookup_schema(id);
  if (schema == NULL)
    return;

  if (!pattern_valid(pattern)) {
    g_warning("Invalid settings pattern: %s", pattern);
    return;
  }

  const gchar *fixed = g_settings_schema_get_path(schema);
  if (fixed != NULL) {
    g_warning("Settings schema %s has the fixed path %s, not a pattern", id,
              fixed);
    return;
  }

  Pattern *entry = g_new(Pattern, 1);
  entry->pattern = g_strdup(pattern);
  entry->schema = g_settings_schema_ref(schema);
  g_mutex_lock(&backend->lock);
  g_ptr_array_add(backend->patterns, entry);
  g_mutex_unlock(&backend->lock);
}

static gboolean declare(IBusWebSettingsBackend *backend, const gchar *id,
                        const gchar *path) {
  g_autoptr(GSettingsSchema) schema = lookup_schema(id);
  if (schema == NULL)
    return FALSE;

  if (!path_valid(path)) {
    g_warning("Invalid settings path: %s", path);
    return FALSE;
  }

  const gchar *fixed = g_settings_schema_get_path(schema);
  if (fixed != NULL && !g_str_equal(fixed, path)) {
    g_warning("Settings schema %s has the fixed path %s, not %s", id, fixed,
              path);
    return FALSE;
  }

  g_mutex_lock(&backend->lock);
  g_hash_table_replace(backend->instances, g_strdup(path),
                       g_settings_schema_ref(schema));
  g_mutex_unlock(&backend->lock);
  return TRUE;
}

/* Caller holds the lock. The schema of the instance at path, borrowed, or
 * NULL: one Init declared, or one a pattern matches, which is declared then,
 * so that later lookups find it as they find Init's. */
static GSettingsSchema *instance_at_locked(IBusWebSettingsBackend *backend,
                                           const gchar *path) {
  GSettingsSchema *schema = g_hash_table_lookup(backend->instances, path);
  for (guint i = 0; schema == NULL && i < backend->patterns->len; i++) {
    Pattern *pattern = g_ptr_array_index(backend->patterns, i);
    if (!pattern_matches(pattern->pattern, path))
      continue;

    schema = pattern->schema;
    g_hash_table_replace(backend->instances, g_strdup(path),
                         g_settings_schema_ref(schema));
  }
  return schema;
}

static GSettingsSchema *instance_at(IBusWebSettingsBackend *backend,
                                    const gchar *path) {
  g_mutex_lock(&backend->lock);
  GSettingsSchema *schema = instance_at_locked(backend, path);
  if (schema != NULL)
    g_settings_schema_ref(schema);
  g_mutex_unlock(&backend->lock);

  return schema;
}

static SettingKey *resolve_key(IBusWebSettingsBackend *backend,
                               const gchar *path, const gchar *name,
                               gint *error) {
  g_autoptr(GSettingsSchema) schema = instance_at(backend, path);
  if (schema == NULL) {
    g_warning("Unknown settings path: %s", path);
    *error = -ENOENT;
    return NULL;
  }

  if (!g_settings_schema_has_key(schema, name)) {
    g_warning("Unknown settings key: %s%s", path, name);
    *error = -ENOENT;
    return NULL;
  }

  *error = 0;
  return key_new(schema, path, name);
}

/* A key path belongs to the longest declared instance path that prefixes it
 * and whose schema has the rest as a key. */
static SettingKey *resolve_path(IBusWebSettingsBackend *backend,
                                const gchar *path) {
  g_autoptr(GSettingsSchema) best = NULL;
  g_autofree gchar *best_path = NULL;
  gsize best_length = 0;

  g_mutex_lock(&backend->lock);

  /* A key's name holds no '/', so a pattern's instance is the key path's
   * directory. */
  const gchar *slash = strrchr(path, '/');
  if (slash != NULL) {
    g_autofree gchar *directory = g_strndup(path, slash + 1 - path);
    instance_at_locked(backend, directory);
  }

  GHashTableIter iter;
  gpointer instance, schema;
  g_hash_table_iter_init(&iter, backend->instances);
  while (g_hash_table_iter_next(&iter, &instance, &schema)) {
    gsize length = strlen(instance);
    if (length > best_length && g_str_has_prefix(path, instance) &&
        g_settings_schema_has_key(schema, path + length)) {
      g_clear_pointer(&best, g_settings_schema_unref);
      g_clear_pointer(&best_path, g_free);
      best = g_settings_schema_ref(schema);
      best_path = g_strdup(instance);
      best_length = length;
    }
  }
  g_mutex_unlock(&backend->lock);

  if (best == NULL) {
    g_warning("Unknown settings path: %s", path);
    return NULL;
  }

  return key_new(best, best_path, path + best_length);
}

static gboolean value_valid(SettingKey *key, GVariant *value) {
  if (g_variant_is_of_type(
          value, g_settings_schema_key_get_value_type(key->definition)) &&
      g_settings_schema_key_range_check(key->definition, value))
    return TRUE;

  g_warning("Invalid value for settings key: %s", key->path);
  return FALSE;
}

/* Caller holds the store lock; a missing value has the schema's default. */
static gboolean store_value(IBusWebSettingsBackend *backend, SettingKey *key,
                            GVariant *value) {
  GVariant *old = g_hash_table_lookup(backend->values, key->path);
  g_autoptr(GVariant) fallback = NULL;
  if (old == NULL) {
    fallback = g_settings_schema_key_get_default_value(key->definition);
    old = fallback;
  }

  gboolean changed = !g_variant_equal(old, value);
  g_hash_table_replace(backend->values, g_strdup(key->path),
                       g_variant_ref(value));
  return changed;
}

static void emit_write(SettingKey *key, GVariant *value) {
  ibusweb_output_append(
      0, IBUSWEB_REC_SETTING_WRITTEN,
      g_variant_new("(ssv)", key->instance, key->name, value));
}

static gboolean write_value(IBusWebSettingsBackend *backend, SettingKey *key,
                            GVariant *value, gpointer origin) {
  if (!value_valid(key, value))
    return FALSE;

  g_mutex_lock(&backend->lock);
  gboolean changed = store_value(backend, key, value);
  g_mutex_unlock(&backend->lock);

  if (changed)
    g_settings_backend_changed(G_SETTINGS_BACKEND(backend), key->path, origin);
  emit_write(key, value);
  return TRUE;
}

static GVariant *read_value(GSettingsBackend *base, const gchar *path,
                            const GVariantType *type, gboolean default_value) {
  if (default_value)
    return NULL;

  IBusWebSettingsBackend *backend = (IBusWebSettingsBackend *)base;
  g_mutex_lock(&backend->lock);
  GVariant *value = g_hash_table_lookup(backend->values, path);
  value = value != NULL && g_variant_is_of_type(value, type)
              ? g_variant_ref(value)
              : NULL;
  g_mutex_unlock(&backend->lock);

  return value;
}

static gboolean writable(GSettingsBackend *base G_GNUC_UNUSED,
                         const gchar *path G_GNUC_UNUSED) {
  return TRUE;
}

static gboolean backend_write(GSettingsBackend *base, const gchar *path,
                              GVariant *value, gpointer origin) {
  IBusWebSettingsBackend *backend = (IBusWebSettingsBackend *)base;
  g_autoptr(SettingKey) key = resolve_path(backend, path);
  return key != NULL && write_value(backend, key, value, origin);
}

static void reset(GSettingsBackend *base, const gchar *path, gpointer origin) {
  IBusWebSettingsBackend *backend = (IBusWebSettingsBackend *)base;
  g_autoptr(SettingKey) key = resolve_path(backend, path);
  if (key == NULL)
    return;

  g_autoptr(GVariant) value =
      g_settings_schema_key_get_default_value(key->definition);
  write_value(backend, key, value, origin);
}

typedef struct {
  SettingKey *key;
  GVariant *value;
} PendingWrite;

static void pending_free(gpointer data) {
  PendingWrite *pending = data;
  key_free(pending->key);
  g_variant_unref(pending->value);
  g_free(pending);
}

typedef struct {
  IBusWebSettingsBackend *backend;
  GPtrArray *writes;
  gboolean valid;
} WriteTree;

static gboolean prepare_write(gpointer path, gpointer value, gpointer data) {
  WriteTree *tree = data;
  SettingKey *key = resolve_path(tree->backend, path);
  if (key == NULL) {
    tree->valid = FALSE;
    return TRUE;
  }

  GVariant *resolved =
      value == NULL ? g_settings_schema_key_get_default_value(key->definition)
                    : g_variant_ref(value);
  if (!value_valid(key, resolved)) {
    key_free(key);
    g_variant_unref(resolved);
    tree->valid = FALSE;
    return TRUE;
  }

  PendingWrite *pending = g_new(PendingWrite, 1);
  pending->key = key;
  pending->value = resolved;
  g_ptr_array_add(tree->writes, pending);
  return FALSE;
}

static gboolean write_tree(GSettingsBackend *base, GTree *values,
                           gpointer origin) {
  IBusWebSettingsBackend *backend = (IBusWebSettingsBackend *)base;
  g_autoptr(GPtrArray) pending = g_ptr_array_new_with_free_func(pending_free);
  WriteTree tree = {backend, pending, TRUE};
  g_tree_foreach(values, prepare_write, &tree);
  if (!tree.valid)
    return FALSE;

  g_mutex_lock(&backend->lock);
  for (guint i = 0; i < pending->len; ++i) {
    PendingWrite *entry = g_ptr_array_index(pending, i);
    store_value(backend, entry->key, entry->value);
  }
  g_mutex_unlock(&backend->lock);

  /* Observers see the complete transaction before receiving any notification.
   */
  g_settings_backend_changed_tree(base, values, origin);
  for (guint i = 0; i < pending->len; ++i) {
    PendingWrite *entry = g_ptr_array_index(pending, i);
    emit_write(entry->key, entry->value);
  }
  return TRUE;
}

static void value_unref(gpointer data) { g_variant_unref(data); }

static void schema_unref(gpointer data) { g_settings_schema_unref(data); }

static void finalize(GObject *object) {
  IBusWebSettingsBackend *backend = (IBusWebSettingsBackend *)object;
  g_hash_table_unref(backend->values);
  g_hash_table_unref(backend->instances);
  g_ptr_array_unref(backend->patterns);
  g_mutex_clear(&backend->lock);
  G_OBJECT_CLASS(ibusweb_settings_backend_parent_class)->finalize(object);
}

static void
ibusweb_settings_backend_class_init(IBusWebSettingsBackendClass *klass) {
  GSettingsBackendClass *backend = G_SETTINGS_BACKEND_CLASS(klass);
  backend->read = read_value;
  backend->get_writable = writable;
  backend->write = backend_write;
  backend->write_tree = write_tree;
  backend->reset = reset;
  G_OBJECT_CLASS(klass)->finalize = finalize;
}

static void ibusweb_settings_backend_init(IBusWebSettingsBackend *backend) {
  g_mutex_init(&backend->lock);
  backend->values =
      g_hash_table_new_full(g_str_hash, g_str_equal, g_free, value_unref);
  backend->instances =
      g_hash_table_new_full(g_str_hash, g_str_equal, g_free, schema_unref);
  backend->patterns = g_ptr_array_new_with_free_func(pattern_free);
}

static GSettingsBackend *default_backend(void) {
  GSettingsBackend *backend = g_settings_backend_get_default();
  if (!G_TYPE_CHECK_INSTANCE_TYPE(backend,
                                  ibusweb_settings_backend_get_type())) {
    g_warning("The default settings backend is not ibus-web");
    g_object_unref(backend);
    return NULL;
  }

  return backend;
}

void ibusweb_settings_init(GVariant *instances, GVariant *patterns) {
  g_autoptr(GSettingsBackend) base = default_backend();
  if (base == NULL)
    return;

  IBusWebSettingsBackend *backend = (IBusWebSettingsBackend *)base;
  GVariantIter entries;
  const gchar *id, *path;

  /* Before the instances, whose own declarations need none of them, so that
   * values stored at a pattern's instances are checked against its schema. */
  g_variant_iter_init(&entries, patterns);
  while (g_variant_iter_next(&entries, "(&s&s)", &id, &path))
    declare_pattern(backend, id, path);

  GVariant *values;
  g_variant_iter_init(&entries, instances);
  while (g_variant_iter_next(&entries, "(&s&s@a{sv})", &id, &path, &values)) {
    if (declare(backend, id, path)) {
      GVariantIter keys;
      const gchar *name;
      GVariant *value;
      g_variant_iter_init(&keys, values);
      while (g_variant_iter_next(&keys, "{&sv}", &name, &value)) {
        gint error;
        g_autoptr(SettingKey) key = resolve_key(backend, path, name, &error);

        if (key != NULL && value_valid(key, value)) {
          g_mutex_lock(&backend->lock);
          store_value(backend, key, value);
          g_mutex_unlock(&backend->lock);
        }
        g_variant_unref(value);
      }
    }

    g_variant_unref(values);
  }
}

int ibusweb_settings_changed(const char *path, const char *name,
                             GVariant *value) {
  g_autoptr(GSettingsBackend) base = default_backend();
  if (base == NULL)
    return -ENOTSUP;

  IBusWebSettingsBackend *backend = (IBusWebSettingsBackend *)base;
  gint error;
  g_autoptr(SettingKey) key = resolve_key(backend, path, name, &error);
  if (key == NULL)
    return error;
  if (!value_valid(key, value))
    return -EINVAL;

  g_mutex_lock(&backend->lock);
  gboolean changed = store_value(backend, key, value);
  g_mutex_unlock(&backend->lock);

  if (changed)
    g_settings_backend_changed(base, key->path, NULL);
  return 0;
}

void ibusweb_settings_register(void) {
  /* The memory backend registers GIO's extension points through public API. */
  GSettingsBackend *bootstrap = g_memory_settings_backend_new();
  g_object_unref(bootstrap);
  g_io_extension_point_implement(G_SETTINGS_BACKEND_EXTENSION_POINT_NAME,
                                 ibusweb_settings_backend_get_type(),
                                 "ibus-web", 1000);
}
