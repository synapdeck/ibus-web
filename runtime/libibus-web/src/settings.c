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
  GHashTable *values;
} IBusWebSettingsBackend;
typedef struct {
  GSettingsBackendClass parent;
} IBusWebSettingsBackendClass;
G_DEFINE_TYPE(IBusWebSettingsBackend, ibusweb_settings_backend,
              G_TYPE_SETTINGS_BACKEND)

typedef struct {
  gchar *schema;
  gchar *name;
  gchar *path;
  GSettingsSchemaKey *definition;
} SettingKey;

static void key_free(gpointer data) {
  SettingKey *key = data;
  g_free(key->schema);
  g_free(key->name);
  g_free(key->path);
  g_settings_schema_key_unref(key->definition);
  g_free(key);
}
G_DEFINE_AUTOPTR_CLEANUP_FUNC(SettingKey, key_free)

static SettingKey *key_new(GSettingsSchema *schema, const gchar *name) {
  SettingKey *key = g_new(SettingKey, 1);
  key->schema = g_strdup(g_settings_schema_get_id(schema));
  key->name = g_strdup(name);
  key->path = g_strconcat(g_settings_schema_get_path(schema), name, NULL);
  key->definition = g_settings_schema_get_key(schema, name);
  return key;
}

static SettingKey *resolve_key(const gchar *id, const gchar *name,
                               gint *error) {
  GSettingsSchemaSource *source = g_settings_schema_source_get_default();
  g_autoptr(GSettingsSchema) schema =
      source == NULL ? NULL : g_settings_schema_source_lookup(source, id, TRUE);
  if (schema == NULL) {
    g_warning("Unknown settings schema: %s", id);
    *error = -ENOENT;
    return NULL;
  }
  if (g_settings_schema_get_path(schema) == NULL) {
    g_warning("Relocatable settings schema is unsupported: %s", id);
    *error = -ENOTSUP;
    return NULL;
  }
  if (!g_settings_schema_has_key(schema, name)) {
    g_warning("Unknown settings key: %s:%s", id, name);
    *error = -ENOENT;
    return NULL;
  }
  *error = 0;
  return key_new(schema, name);
}

static SettingKey *resolve_path(const gchar *path) {
  GSettingsSchemaSource *source = g_settings_schema_source_get_default();
  if (source == NULL)
    return NULL;
  g_auto(GStrv) ids = NULL;
  g_auto(GStrv) relocatable = NULL;
  g_settings_schema_source_list_schemas(source, TRUE, &ids, &relocatable);
  g_autoptr(GSettingsSchema) best = NULL;
  gsize best_length = 0;
  for (guint i = 0; ids[i] != NULL; ++i) {
    g_autoptr(GSettingsSchema) schema =
        g_settings_schema_source_lookup(source, ids[i], TRUE);
    const gchar *prefix = g_settings_schema_get_path(schema);
    gsize length = strlen(prefix);
    if (length > best_length && g_str_has_prefix(path, prefix) &&
        g_settings_schema_has_key(schema, path + length)) {
      g_clear_pointer(&best, g_settings_schema_unref);
      best = g_settings_schema_ref(schema);
      best_length = length;
    }
  }
  if (best == NULL) {
    g_warning("Unknown settings path: %s", path);
    return NULL;
  }
  return key_new(best, path + best_length);
}

static gboolean value_valid(SettingKey *key, GVariant *value) {
  if (g_variant_is_of_type(
          value, g_settings_schema_key_get_value_type(key->definition)) &&
      g_settings_schema_key_range_check(key->definition, value))
    return TRUE;
  g_warning("Invalid value for settings key: %s:%s", key->schema, key->name);
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
  ibusweb_output_append(0, IBUSWEB_REC_SETTING_WRITTEN,
                        g_variant_new("(ssv)", key->schema, key->name, value));
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
  g_autoptr(SettingKey) key = resolve_path(path);
  return key != NULL &&
         write_value((IBusWebSettingsBackend *)base, key, value, origin);
}

static void reset(GSettingsBackend *base, const gchar *path, gpointer origin) {
  g_autoptr(SettingKey) key = resolve_path(path);
  if (key == NULL)
    return;
  g_autoptr(GVariant) value =
      g_settings_schema_key_get_default_value(key->definition);
  write_value((IBusWebSettingsBackend *)base, key, value, origin);
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
  GPtrArray *writes;
  gboolean valid;
} WriteTree;

static gboolean prepare_write(gpointer path, gpointer value, gpointer data) {
  WriteTree *tree = data;
  SettingKey *key = resolve_path(path);
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
  g_autoptr(GPtrArray) pending = g_ptr_array_new_with_free_func(pending_free);
  WriteTree tree = {pending, TRUE};
  g_tree_foreach(values, prepare_write, &tree);
  if (!tree.valid)
    return FALSE;
  IBusWebSettingsBackend *backend = (IBusWebSettingsBackend *)base;
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

static void finalize(GObject *object) {
  IBusWebSettingsBackend *backend = (IBusWebSettingsBackend *)object;
  g_hash_table_unref(backend->values);
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

void ibusweb_settings_init(GVariant *snapshot) {
  g_autoptr(GSettingsBackend) base = default_backend();
  if (base == NULL)
    return;
  IBusWebSettingsBackend *backend = (IBusWebSettingsBackend *)base;
  GVariantIter schemas;
  const gchar *id;
  GVariant *values;
  g_variant_iter_init(&schemas, snapshot);
  while (g_variant_iter_next(&schemas, "{&s@a{sv}}", &id, &values)) {
    GVariantIter keys;
    const gchar *name;
    GVariant *value;
    g_variant_iter_init(&keys, values);
    while (g_variant_iter_next(&keys, "{&sv}", &name, &value)) {
      gint error;
      g_autoptr(SettingKey) key = resolve_key(id, name, &error);
      if (key != NULL && value_valid(key, value)) {
        g_mutex_lock(&backend->lock);
        store_value(backend, key, value);
        g_mutex_unlock(&backend->lock);
      }
      g_variant_unref(value);
    }
    g_variant_unref(values);
  }
}

int ibusweb_settings_changed(const char *schema, const char *name,
                             GVariant *value) {
  gint error;
  g_autoptr(SettingKey) key = resolve_key(schema, name, &error);
  if (key == NULL)
    return error;
  if (!value_valid(key, value))
    return -EINVAL;
  g_autoptr(GSettingsBackend) base = default_backend();
  if (base == NULL)
    return -ENOTSUP;
  IBusWebSettingsBackend *backend = (IBusWebSettingsBackend *)base;
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
