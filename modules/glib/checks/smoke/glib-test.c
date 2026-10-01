/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* Exercises each GLib library once: GLib (key files, GRegex, threads, a main
 * context, callbacks cast to GCompareFunc, time zones), GObject (a property
 * notification, a dynamic type, signal class handlers) and GIO (reading a
 * file back, file and resource attributes, the memory monitor). Also checks
 * that blocking main-context iteration sleeps instead of spinning, wakes
 * when another thread changes the context, with or without fds to watch,
 * and that a cancellable's fd can be polled. */
#include <emscripten.h>
#include <gio/gio.h>
#include <glib-object.h>
#include <glib.h>
#include <stdio.h>
#include <unistd.h>

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

/* CPU time of the whole process, every thread included. Emscripten's
 * clock() counts wall time and its getrusage() is a stub, so ask Node. */
EM_JS(double, process_cpu_ms, (void), {
  const usage = process.cpuUsage();
  return (usage.user + usage.system) / 1000;
});

static gpointer run_loop(gpointer loop) {
  g_main_loop_run(loop);
  return NULL;
}

static gboolean quit_loop(gpointer loop) {
  g_main_loop_quit(loop);
  return G_SOURCE_REMOVE;
}

/* A source watching one fd for input through g_source_add_unix_fd(). */
typedef struct {
  GSource source;
  gpointer tag;
} FdSource;

static gboolean fd_source_check(GSource *source) {
  return (g_source_query_unix_fd(source, ((FdSource *)source)->tag) &
          G_IO_IN) != 0;
}

static gboolean fd_source_dispatch(GSource *source, GSourceFunc callback,
                                   gpointer user_data) {
  (void)source;
  return callback(user_data);
}

static GSourceFuncs fd_source_funcs = {
    NULL, fd_source_check, fd_source_dispatch, NULL, NULL, NULL,
};

static GSource *fd_source_new(int fd) {
  GSource *source = g_source_new(&fd_source_funcs, sizeof(FdSource));
  ((FdSource *)source)->tag = g_source_add_unix_fd(source, fd, G_IO_IN);
  return source;
}

static gpointer cancel_later(gpointer cancellable) {
  g_usleep(50000);
  g_cancellable_cancel(cancellable);
  return NULL;
}

static gboolean query_boolean(const char *path, const char *attribute) {
  GFile *file = g_file_new_for_path(path);
  GFileInfo *info = g_file_query_info(file, attribute, 0, NULL, NULL);
  gboolean value = info && g_file_info_get_attribute_boolean(info, attribute);
  g_clear_object(&info);
  g_object_unref(file);
  return value;
}

static void task_thread(GTask *task, gpointer source_object, gpointer task_data,
                        GCancellable *cancellable) {
  (void)source_object;
  (void)task_data;
  (void)cancellable;
  g_task_return_int(task, 7);
}

static void task_done(GObject *source_object, GAsyncResult *result,
                      gpointer user_data) {
  (void)source_object;
  *(gssize *)user_data = g_task_propagate_int(G_TASK(result), NULL);
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

/* Signals with class handlers, which take no user data, called through a C
 * marshaller that passes some. */
typedef struct {
  GObject parent;
} Signaller;

typedef struct {
  GObjectClass parent;
  void (*poke)(Signaller *self);
  gboolean (*judge)(Signaller *self, int value);
} SignallerClass;

static GType signaller_get_type(void);
static GString *trail;
static guint judge_signal;

G_DEFINE_TYPE(Signaller, signaller, G_TYPE_OBJECT)

static void signaller_poke(Signaller *self) {
  (void)self;
  g_string_append(trail, "poke;");
}

static gboolean signaller_judge(Signaller *self, int value) {
  (void)self;
  g_string_append_printf(trail, "judge %d;", value);
  return value > 0;
}

static void marshal_BOOLEAN__INT(GClosure *closure, GValue *return_value,
                                 guint n_param_values,
                                 const GValue *param_values,
                                 gpointer invocation_hint,
                                 gpointer marshal_data) {
  typedef gboolean (*Func)(gpointer instance, int value, gpointer data);
  GCClosure *cc = (GCClosure *)closure;
  Func callback = (Func)(marshal_data ? marshal_data : cc->callback);
  (void)n_param_values;
  (void)invocation_hint;
  g_value_set_boolean(
      return_value, callback(g_value_peek_pointer(&param_values[0]),
                             g_value_get_int(&param_values[1]), closure->data));
}

static void signaller_class_init(SignallerClass *klass) {
  klass->poke = signaller_poke;
  klass->judge = signaller_judge;
  g_signal_new("poke", G_TYPE_FROM_CLASS(klass), G_SIGNAL_RUN_LAST,
               G_STRUCT_OFFSET(SignallerClass, poke), NULL, NULL,
               g_cclosure_marshal_VOID__VOID, G_TYPE_NONE, 0);
  judge_signal =
      g_signal_new("judge", G_TYPE_FROM_CLASS(klass), G_SIGNAL_RUN_LAST,
                   G_STRUCT_OFFSET(SignallerClass, judge), NULL, NULL,
                   marshal_BOOLEAN__INT, G_TYPE_BOOLEAN, 1, G_TYPE_INT);
}

static void signaller_init(Signaller *self) { (void)self; }

/* Overrides one handler in its class structure and the other with
 * g_signal_override_class_handler(), chaining up from both. */
typedef struct {
  Signaller parent;
} SubSignaller;

typedef struct {
  SignallerClass parent;
} SubSignallerClass;

static GType sub_signaller_get_type(void);

G_DEFINE_TYPE(SubSignaller, sub_signaller, signaller_get_type())

static void sub_signaller_poke(Signaller *self) {
  g_string_append(trail, "sub-poke;");
  g_signal_chain_from_overridden_handler(self);
}

static gboolean sub_signaller_judge(Signaller *self, int value) {
  g_string_append(trail, "sub-judge;");
  return ((SignallerClass *)sub_signaller_parent_class)->judge(self, value + 1);
}

static void sub_signaller_class_init(SubSignallerClass *klass) {
  ((SignallerClass *)klass)->judge = sub_signaller_judge;
  g_signal_override_class_handler("poke", G_TYPE_FROM_CLASS(klass),
                                  G_CALLBACK(sub_signaller_poke));
}

static void sub_signaller_init(SubSignaller *self) { (void)self; }

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

  /* In the temporary directory, which WasmFS keeps in memory, as in the
   * browser. */
  gchar *path = g_build_filename(g_get_tmp_dir(), "glib-test.txt", NULL);
  g_file_set_contents(path, "gio", -1, NULL);
  GFile *file = g_file_new_for_path(path);
  gchar *contents = NULL;
  g_file_load_contents(file, NULL, &contents, NULL, NULL, NULL);
  printf("gio %s\n", contents);
  g_free(contents);
  g_object_unref(file);
  g_free(path);

  /* A dangling symlink exists, but following it, as G_FILE_TEST_EXISTS
   * does, finds nothing. */
  symlink("glib-test-missing", "glib-test-dangling");
  GFile *dangling = g_file_new_for_path("glib-test-dangling");
  printf("exists %d %d %d\n", g_file_query_exists(dangling, NULL),
         g_file_test("glib-test-dangling", G_FILE_TEST_IS_SYMLINK),
         g_file_test("glib-test-dangling", G_FILE_TEST_EXISTS));
  g_object_unref(dangling);

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

  /* The loop thread is asleep by the time the source is attached, and only
   * the context's wakeup can end its wait. */
  GMainContext *loop_context = g_main_context_new();
  GMainLoop *loop = g_main_loop_new(loop_context, FALSE);
  GThread *looper = g_thread_new("loop", run_loop, loop);
  while (!g_main_loop_is_running(loop))
    g_usleep(1000);
  g_usleep(50000);
  GSource *quitter = g_idle_source_new();
  g_source_set_callback(quitter, quit_loop, loop, NULL);
  g_source_attach(quitter, loop_context);
  g_source_unref(quitter);
  /* Reaching the join at all is the assertion: without a working wakeup
   * the loop never sees the quitter and the check's timeout fails it. */
  g_thread_join(looper);
  printf("wakeup %d\n", !g_main_loop_is_running(loop));
  g_main_loop_unref(loop);
  g_main_context_unref(loop_context);

  /* With an fd to watch the loop thread probes it between waits on the
   * context's wakeup, and must still wake when the wakeup is signalled.
   * Then the fd turns ready and its source quits a second run. */
  int fd_pipe[2];
  int piped = pipe(fd_pipe) == 0;
  GMainContext *fd_context = g_main_context_new();
  GMainLoop *fd_loop = g_main_loop_new(fd_context, FALSE);
  GSource *fd_watch = fd_source_new(fd_pipe[0]);
  g_source_set_callback(fd_watch, quit_loop, fd_loop, NULL);
  g_source_attach(fd_watch, fd_context);
  g_source_unref(fd_watch);
  GThread *fd_looper = g_thread_new("fd-loop", run_loop, fd_loop);
  while (!g_main_loop_is_running(fd_loop))
    g_usleep(1000);
  g_usleep(50000);
  gint64 fd_signalled = g_get_monotonic_time();
  GSource *fd_quitter = g_idle_source_new();
  g_source_set_callback(fd_quitter, quit_loop, fd_loop, NULL);
  g_source_attach(fd_quitter, fd_context);
  g_source_unref(fd_quitter);
  g_thread_join(fd_looper);
  printf("fdwait latency %.1f ms\n",
         (g_get_monotonic_time() - fd_signalled) / 1000.0);
  int fd_woke = !g_main_loop_is_running(fd_loop);
  int fd_written = write(fd_pipe[1], "x", 1) == 1;
  fd_looper = g_thread_new("fd-loop", run_loop, fd_loop);
  g_thread_join(fd_looper);
  printf("fdwait %d %d %d\n", piped && fd_written, fd_woke,
         !g_main_loop_is_running(fd_loop));
  g_main_loop_unref(fd_loop);
  g_main_context_unref(fd_context);
  close(fd_pipe[0]);
  close(fd_pipe[1]);

  /* A cancellable's fd turns ready once another thread cancels it, g_poll()
   * waits for that, and resetting the cancellable clears it. */
  GCancellable *cancellable = g_cancellable_new();
  GPollFD cancel_fd;
  int made = g_cancellable_make_pollfd(cancellable, &cancel_fd);
  GThread *canceller = g_thread_new("cancel", cancel_later, cancellable);
  int cancel_ready = g_poll(&cancel_fd, 1, -1) == 1 &&
                     (cancel_fd.revents & G_IO_IN) &&
                     g_cancellable_is_cancelled(cancellable);
  g_thread_join(canceller);
  g_cancellable_reset(cancellable);
  int cancel_cleared = g_poll(&cancel_fd, 1, 0) == 0;
  g_cancellable_release_fd(cancellable);
  g_object_unref(cancellable);
  printf("cancellable %d %d %d\n", made, cancel_ready, cancel_cleared);

  /* A spinning wait would burn as much CPU time as it takes wall time. */
  GMainContext *timed = g_main_context_new();
  gint64 timed_start = g_get_monotonic_time();
  GSource *timeout = g_timeout_source_new(200);
  int fired = 0;
  g_source_set_callback(timeout, count_idle, &fired, NULL);
  g_source_attach(timeout, timed);
  g_source_unref(timeout);
  double timed_cpu = process_cpu_ms();
  g_main_context_iteration(timed, TRUE);
  timed_cpu = process_cpu_ms() - timed_cpu;
  double timed_wall = (g_get_monotonic_time() - timed_start) / 1000.0;
  g_main_context_unref(timed);
  printf("blocking wall %.1f ms, cpu %.1f ms\n", timed_wall, timed_cpu);
  printf("blocking %d %d %d\n", fired, timed_wall >= 200,
         timed_cpu < timed_wall / 4);

  /* GTask starts GLib's worker context, whose thread then blocks in its
   * loop for the rest of the program. */
  gssize task_result = 0;
  GTask *task = g_task_new(NULL, NULL, task_done, &task_result);
  g_task_run_in_thread(task, task_thread);
  g_object_unref(task);
  while (task_result == 0)
    g_main_context_iteration(NULL, TRUE);
  double idle_cpu = process_cpu_ms();
  gint64 idle_start = g_get_monotonic_time();
  g_usleep(300000);
  idle_cpu = process_cpu_ms() - idle_cpu;
  double idle_wall = (g_get_monotonic_time() - idle_start) / 1000.0;
  printf("worker wall %.1f ms, cpu %.1f ms\n", idle_wall, idle_cpu);
  printf("worker %d %d\n", (int)task_result, idle_cpu < idle_wall / 4);

  GTypeModule *module = g_object_new(thing_module_get_type(), NULL);
  g_type_module_use(module);
  GObject *thing = g_object_new(dynamic_thing_get_type(), NULL);
  printf("dynamic %s %d %d\n", G_OBJECT_TYPE_NAME(thing), class_inits,
         instance_inits);
  g_object_unref(thing);
  g_type_module_unuse(module);

  printf("processors %s\n", g_get_num_processors() > 0 ? "yes" : "no");

  /* Zones come from JavaScript's Intl API: Berlin in January and July 2024,
   * and whatever zone this process is in. */
  GTimeZone *berlin = g_time_zone_new_identifier("Europe/Berlin");
  GTimeZone *local = g_time_zone_new_local();
  int winter = 0, summer = 0;
  if (berlin) {
    winter = g_time_zone_get_offset(
        berlin,
        g_time_zone_find_interval(berlin, G_TIME_TYPE_UNIVERSAL, 1704067200));
    summer = g_time_zone_get_offset(
        berlin,
        g_time_zone_find_interval(berlin, G_TIME_TYPE_UNIVERSAL, 1719792000));
  }
  printf("timezone local %s\n", g_time_zone_get_identifier(local));
  printf("timezone %s %d %d %d\n",
         berlin ? g_time_zone_get_identifier(berlin) : "none", winter, summer,
         g_time_zone_get_identifier(local)[0] != '\0');
  if (berlin)
    g_time_zone_unref(berlin);
  g_time_zone_unref(local);

  gchar *dotfile = g_build_filename(g_get_tmp_dir(), ".glib-test", NULL);
  gchar *backup = g_build_filename(g_get_tmp_dir(), "glib-test~", NULL);
  g_file_set_contents(dotfile, "", 0, NULL);
  g_file_set_contents(backup, "", 0, NULL);
  printf("attributes %d %d\n",
         query_boolean(dotfile, G_FILE_ATTRIBUTE_STANDARD_IS_HIDDEN),
         query_boolean(backup, G_FILE_ATTRIBUTE_STANDARD_IS_BACKUP));
  g_free(dotfile);
  g_free(backup);

  /* The check compiles this resource from a text file before the run. */
  GResource *resource = g_resource_load("glib-test.gresource", NULL);
  if (resource)
    g_resources_register(resource);
  GFile *resource_file =
      g_file_new_for_uri("resource:///org/example/glib-test.txt");
  GFileInfo *resource_info = g_file_query_info(
      resource_file, G_FILE_ATTRIBUTE_STANDARD_CONTENT_TYPE, 0, NULL, NULL);
  const char *resource_type =
      resource_info ? g_file_info_get_content_type(resource_info) : NULL;
  printf("resource %s\n", resource_type ? resource_type : "none");
  g_clear_object(&resource_info);
  g_object_unref(resource_file);

  GMemoryMonitor *memory = g_memory_monitor_dup_default();
  printf("memory %d\n", memory != NULL);
  g_clear_object(&memory);

  trail = g_string_new(NULL);
  gboolean base_verdict = FALSE, sub_verdict = TRUE;
  GObject *base = g_object_new(signaller_get_type(), NULL);
  g_signal_emit_by_name(base, "poke");
  g_signal_emit(base, judge_signal, 0, 5, &base_verdict);
  GObject *sub = g_object_new(sub_signaller_get_type(), NULL);
  g_signal_emit_by_name(sub, "poke");
  g_signal_emit(sub, judge_signal, 0, -1, &sub_verdict);
  printf("signals %s %d %d\n", trail->str, base_verdict, sub_verdict);
  g_object_unref(sub);
  g_object_unref(base);
  g_string_free(trail, TRUE);

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
