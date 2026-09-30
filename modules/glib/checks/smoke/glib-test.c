/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* Exercises each GLib library once: GLib (key files, GRegex, threads, a main
 * context, callbacks cast to GCompareFunc), GObject (a property notification,
 * a dynamic type) and GIO (reading a file back). */
#include <gio/gio.h>
#include <glib-object.h>
#include <glib.h>
#include <stdio.h>

static gpointer add_one(gpointer data) {
  return GINT_TO_POINTER(GPOINTER_TO_INT(data) + 1);
}

static void on_notify(GObject *object, GParamSpec *pspec, gpointer user_data) {
  (void)object;
  (void)pspec;
  *(int *)user_data += 1;
}

static gboolean count_idle(gpointer user_data) {
  *(int *)user_data += 1;
  return G_SOURCE_REMOVE;
}

/* A dynamic type, registered by its GTypeModule when the module loads. */
typedef struct {
  GObject parent;
} DynamicThing;

typedef struct {
  GObjectClass parent;
} DynamicThingClass;

static int class_inits, instance_inits;

G_DEFINE_DYNAMIC_TYPE(DynamicThing, dynamic_thing, G_TYPE_OBJECT)

static void dynamic_thing_class_init(DynamicThingClass *klass) {
  (void)klass;
  class_inits += 1;
}

static void dynamic_thing_class_finalize(DynamicThingClass *klass) {
  (void)klass;
}

static void dynamic_thing_init(DynamicThing *self) {
  (void)self;
  instance_inits += 1;
}

typedef struct {
  GTypeModule parent;
} ThingModule;

typedef struct {
  GTypeModuleClass parent;
} ThingModuleClass;

static GType thing_module_get_type(void);

G_DEFINE_TYPE(ThingModule, thing_module, G_TYPE_TYPE_MODULE)

static gboolean thing_module_load(GTypeModule *module) {
  dynamic_thing_register_type(module);
  return TRUE;
}

static void thing_module_unload(GTypeModule *module) { (void)module; }

static void thing_module_class_init(ThingModuleClass *klass) {
  GTypeModuleClass *module_class = G_TYPE_MODULE_CLASS(klass);
  module_class->load = thing_module_load;
  module_class->unload = thing_module_unload;
}

static void thing_module_init(ThingModule *self) { (void)self; }

int main(void) {
  GKeyFile *keys = g_key_file_new();
  g_key_file_load_from_data(keys, "[engine]\nname=hangul\n", -1,
                            G_KEY_FILE_NONE, NULL);
  gchar *name = g_key_file_get_string(keys, "engine", "name", NULL);
  printf("keyfile %s\n", name);
  g_free(name);
  g_key_file_free(keys);

  GRegex *regex = g_regex_new("^(\\w+)-(\\d+)$", 0, 0, NULL);
  GMatchInfo *match = NULL;
  gboolean matched = g_regex_match(regex, "glib-288", 0, &match);
  gchar *number = matched ? g_match_info_fetch(match, 2) : g_strdup("none");
  printf("regex %s\n", number);
  g_free(number);
  g_match_info_free(match);
  g_regex_unref(regex);

  GThread *thread = g_thread_new("add-one", add_one, GINT_TO_POINTER(41));
  printf("thread %d\n", GPOINTER_TO_INT(g_thread_join(thread)));

  GObject *group = g_object_new(G_TYPE_BINDING_GROUP, NULL);
  GObject *source = g_object_new(G_TYPE_OBJECT, NULL);
  int notified = 0;
  g_signal_connect(group, "notify::source", G_CALLBACK(on_notify), &notified);
  g_object_set(group, "source", source, NULL);
  printf("gobject %d\n", notified);
  g_object_unref(group);
  g_object_unref(source);

  /* Relative to the build directory: the sandbox may have no /tmp. */
  g_file_set_contents("glib-test.txt", "gio", -1, NULL);
  GFile *file = g_file_new_for_path("glib-test.txt");
  gchar *contents = NULL;
  g_file_load_contents(file, NULL, &contents, NULL, NULL, NULL);
  printf("gio %s\n", contents);
  g_free(contents);
  g_object_unref(file);

  GMainContext *context = g_main_context_new();
  GSource *idle = g_idle_source_new();
  int idled = 0;
  g_source_set_callback(idle, count_idle, &idled, NULL);
  g_source_attach(idle, context);
  g_source_unref(idle);
  while (g_main_context_iteration(context, FALSE))
    ;
  g_main_context_unref(context);
  printf("mainloop %d\n", idled);

  GTypeModule *module = g_object_new(thing_module_get_type(), NULL);
  g_type_module_use(module);
  GObject *thing = g_object_new(dynamic_thing_get_type(), NULL);
  printf("dynamic %s %d %d\n", G_OBJECT_TYPE_NAME(thing), class_inits,
         instance_inits);
  g_object_unref(thing);
  g_type_module_unuse(module);

  printf("processors %s\n", g_get_num_processors() > 0 ? "yes" : "no");

  GList *list =
      g_list_append(g_list_append(NULL, g_strdup("b")), g_strdup("a"));
  list = g_list_sort(list, (GCompareFunc)g_strcmp0);
  GSList *slist = g_slist_sort(
      g_slist_prepend(g_slist_prepend(NULL, g_strdup("d")), g_strdup("c")),
      (GCompareFunc)g_strcmp0);
  GQueue *queue = g_queue_new();
  g_queue_push_tail(queue, g_strdup("e"));
  printf("casts %s%s%s%s%s\n", (char *)list->data, (char *)list->next->data,
         (char *)slist->data, (char *)slist->next->data,
         (char *)g_queue_peek_head(queue));
  g_list_free_full(list, g_free);
  g_slist_free_full(slist, g_free);
  g_queue_free_full(queue, g_free);
  return 0;
}
