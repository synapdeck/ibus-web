// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
#include "values.h"
#include <unistd.h>

static const char *adapter_path, *engine_path;
static GTestDBus *bus;
static const char *policy_bus_address;

static const char *bus_address(void) {
  return policy_bus_address ? policy_bus_address
                            : g_test_dbus_get_bus_address(bus);
}

typedef struct {
  GMainLoop *loop;
  GSubprocess *process;
  char *out, *err;
  GError *error;
  gboolean timed_out;
} Run;

static gboolean kill_timeout(gpointer data) {
  Run *run = data;
  run->timed_out = TRUE;
  g_subprocess_force_exit(run->process);
  return G_SOURCE_REMOVE;
}

static void communicated(GObject *object, GAsyncResult *result, gpointer data) {
  Run *run = data;
  g_subprocess_communicate_utf8_finish(G_SUBPROCESS(object), result, &run->out,
                                       &run->err, &run->error);
  g_main_loop_quit(run->loop);
}

static void ready(GObject *object, GAsyncResult *result, gpointer data) {
  Run *run = data;
  run->out = g_data_input_stream_read_line_finish(G_DATA_INPUT_STREAM(object),
                                                  result, NULL, &run->error);
  g_main_loop_quit(run->loop);
}

static GSubprocess *start_engine(void) {
  GError *error = NULL;
  GSubprocess *engine = g_subprocess_new(G_SUBPROCESS_FLAGS_STDOUT_PIPE, &error,
                                         engine_path, bus_address(), NULL);
  g_assert_no_error(error);
  Run startup = {.loop = g_main_loop_new(NULL, FALSE), .process = engine};
  GDataInputStream *stream =
      g_data_input_stream_new(g_subprocess_get_stdout_pipe(engine));
  guint timer = g_timeout_add(3000, kill_timeout, &startup);
  g_data_input_stream_read_line_async(stream, G_PRIORITY_DEFAULT, NULL, ready,
                                      &startup);
  g_main_loop_run(startup.loop);
  if (!startup.timed_out)
    g_source_remove(timer);
  g_assert_false(startup.timed_out);
  g_assert_no_error(startup.error);
  g_assert_cmpstr(startup.out, ==, "READY");
  g_free(startup.out);
  g_object_unref(stream);
  g_main_loop_unref(startup.loop);
  return engine;
}

static JsonArray *execute(const char **steps, gboolean success) {
  GSubprocess *engine = start_engine();
  GError *error = NULL;
  GSubprocess *adapter = g_subprocess_new(
      G_SUBPROCESS_FLAGS_STDIN_PIPE | G_SUBPROCESS_FLAGS_STDOUT_PIPE |
          G_SUBPROCESS_FLAGS_STDERR_PIPE,
      &error, adapter_path, "--address", bus_address(), "--destination",
      "org.example.IBusTest", "--factory", "/org/freedesktop/IBus/Factory",
      "--timeout-ms", "200", NULL);
  g_assert_no_error(error);
  char *steps_json = g_strjoinv(",", (char **)steps);
  char *trace = g_strdup_printf(
      "{\"version\":1,\"settings\":[],\"steps\":[%s]}\n", steps_json);
  g_free(steps_json);

  Run run = {.loop = g_main_loop_new(NULL, FALSE), .process = adapter};
  guint timer = g_timeout_add(3000, kill_timeout, &run);
  gint64 before = g_get_monotonic_time();
  g_subprocess_communicate_utf8_async(adapter, trace, NULL, communicated, &run);
  g_main_loop_run(run.loop);
  g_assert_cmpint(g_get_monotonic_time() - before, <, 2500000);
  if (!run.timed_out)
    g_source_remove(timer);
  g_assert_false(run.timed_out);
  g_assert_no_error(run.error);
  g_assert_true(g_subprocess_get_if_exited(adapter));
  g_assert_cmpint(g_subprocess_get_exit_status(adapter), ==, success ? 0 : 1);
  g_assert_cmpstr(run.err, ==, "");

  JsonArray *records = json_array_new();
  char **lines = g_strsplit(run.out, "\n", -1);
  for (guint i = 0; lines[i] && *lines[i]; i++) {
    JsonParser *parser = json_parser_new();
    g_assert_true(json_parser_load_from_data(parser, lines[i], -1, &error));
    g_assert_no_error(error);
    json_array_add_element(records,
                           json_node_copy(json_parser_get_root(parser)));
    g_object_unref(parser);
  }
  g_strfreev(lines);
  g_free(run.out);
  g_free(run.err);
  g_free(trace);
  g_main_loop_unref(run.loop);
  g_object_unref(adapter);
  g_subprocess_force_exit(engine);
  g_subprocess_wait(engine, NULL, NULL);
  g_object_unref(engine);
  return records;
}

#define TRACE(...) ((const char *[]){__VA_ARGS__, NULL})
#define CREATE(context, engine)                                                \
  "{\"op\":\"create\",\"context\":\"" context "\",\"engine\":\"" engine "\"}"
#define DESTROY(context) "{\"op\":\"destroy\",\"context\":\"" context "\"}"
#define CALL(context, method, args)                                            \
  "{\"op\":\"call\",\"context\":\"" context "\",\"method\":\"" method          \
  "\",\"args\":\"" args "\"}"
#define WAIT(context, event)                                                   \
  "{\"op\":\"wait\",\"context\":\"" context "\",\"event\":\"" event            \
  "\",\"timeoutMs\":200}"

static JsonObject *record(JsonArray *records, guint index, const char *kind,
                          guint step) {
  JsonObject *record = json_array_get_object_element(records, index);
  g_assert_cmpstr(json_object_get_string_member(record, "kind"), ==, kind);
  g_assert_cmpint(json_object_get_int_member(record, "step"), ==, step);
  return record;
}

static void lifecycle(void) {
  const char *steps[] = {
      CREATE("a", "fixture"),
      CALL("a", "FocusIn", "()"),
      CALL("a", "ProcessKeyEvent", "(uint32 0, uint32 0, uint32 0)"),
      DESTROY("a"),
      NULL,
  };
  JsonArray *records = execute(steps, TRUE);

  g_assert_cmpuint(json_array_get_length(records), ==, 4);
  JsonObject *created = record(records, 0, "reply", 0);
  g_assert_true(JSON_NODE_HOLDS_NULL(json_object_get_member(created, "value")));
  JsonObject *key_reply = record(records, 2, "reply", 2);
  g_assert_false(json_object_get_boolean_member(key_reply, "value"));
  record(records, 3, "reply", 3);

  json_array_unref(records);
}

static void signal_order(void) {
  const char *steps[] = {
      CREATE("a", "fixture"),
      CALL("a", "ProcessKeyEvent", "(uint32 1, uint32 0, uint32 0)"),
      WAIT("a", "CommitText"),
      DESTROY("a"),
      NULL,
  };
  JsonArray *records = execute(steps, TRUE);

  g_assert_cmpuint(json_array_get_length(records), ==, 5);
  JsonObject *event = record(records, 1, "event", 1);
  g_assert_cmpstr(json_object_get_string_member(event, "name"), ==,
                  "CommitText");
  JsonObject *payload = json_object_get_object_member(event, "payload");
  g_assert_cmpstr(json_object_get_string_member(payload, "signature"), ==,
                  "(v)");
  const char *text = json_object_get_string_member(payload, "text");
  g_assert_nonnull(strstr(text, "한글 🐈"));
  g_assert_nonnull(strstr(text, "'typed': <<uint32 42>>"));

  JsonObject *key_reply = record(records, 2, "reply", 1);
  g_assert_true(json_object_get_boolean_member(key_reply, "value"));
  record(records, 3, "reply", 2);
  json_array_unref(records);
}

static void contexts(void) {
  const char *steps[] = {
      CREATE("a", "fixture"),
      CREATE("b", "fixture"),
      CALL("b", "ProcessKeyEvent", "(uint32 1, uint32 0, uint32 0)"),
      DESTROY("a"),
      DESTROY("b"),
      NULL,
  };
  JsonArray *records = execute(steps, TRUE);

  JsonObject *event = record(records, 2, "event", 2);
  g_assert_cmpstr(json_object_get_string_member(event, "context"), ==, "b");
  g_assert_cmpuint(json_array_get_length(records), ==, 6);
  json_array_unref(records);
}

static void content_type(void) {
  const char *steps[] = {
      CREATE("a", "fixture"),
      CALL("a", "SetContentType", "(uint32 7, uint32 9)"),
      DESTROY("a"),
      NULL,
  };
  JsonArray *records = execute(steps, TRUE);

  JsonObject *event = record(records, 1, "event", 1);
  g_assert_cmpstr(json_object_get_string_member(event, "name"), ==,
                  "ForwardKeyEvent");
  JsonObject *payload = json_object_get_object_member(event, "payload");
  g_assert_cmpstr(json_object_get_string_member(payload, "text"), ==,
                  "(uint32 7, uint32 9, uint32 0)");
  json_array_unref(records);
}

static void delayed_output(void) {
  const char *steps[] = {
      CREATE("a", "fixture"),
      CALL("a", "ProcessKeyEvent", "(uint32 2, uint32 0, uint32 0)"),
      WAIT("a", "CommitText"),
      DESTROY("a"),
      NULL,
  };
  JsonArray *records = execute(steps, TRUE);

  record(records, 1, "reply", 1);
  record(records, 2, "event", 2);
  record(records, 3, "reply", 2);
  g_assert_cmpuint(json_array_get_length(records), ==, 5);
  json_array_unref(records);
}

static void trailing(void) {
  const char *steps[] = {
      CREATE("a", "fixture"),
      CALL("a", "Reset", "()"),
      DESTROY("a"),
      NULL,
  };
  JsonArray *records = execute(steps, TRUE);

  record(records, 1, "reply", 1);
  JsonObject *event = record(records, 2, "event", 2);
  g_assert_cmpstr(json_object_get_string_member(event, "name"), ==,
                  "CommitText");
  g_assert_cmpuint(json_array_get_length(records), ==, 4);
  json_array_unref(records);
}

static void creation_signal(void) {
  const char *steps[] = {
      CREATE("a", "early"),
      WAIT("a", "CommitText"),
      DESTROY("a"),
      NULL,
  };
  JsonArray *records = execute(steps, TRUE);

  record(records, 0, "event", 0);
  record(records, 1, "reply", 0);
  record(records, 2, "reply", 1);
  g_assert_cmpuint(json_array_get_length(records), ==, 4);
  json_array_unref(records);
}

static void interleaved_creation(void) {
  const char *steps[] = {
      CREATE("a", "early"),
      CREATE("b", "interleaved"),
      DESTROY("a"),
      DESTROY("b"),
      NULL,
  };
  JsonArray *records = execute(steps, TRUE);

  JsonObject *created_event = record(records, 2, "event", 1);
  JsonObject *existing_event = record(records, 3, "event", 1);
  g_assert_cmpstr(json_object_get_string_member(created_event, "context"), ==,
                  "b");
  g_assert_cmpstr(json_object_get_string_member(existing_event, "context"), ==,
                  "a");
  record(records, 4, "reply", 1);
  g_assert_cmpuint(json_array_get_length(records), ==, 7);
  json_array_unref(records);
}

static void empty_and_unmatched_events(void) {
  const char *steps[] = {
      CREATE("a", "fixture"),
      CALL("a", "ProcessKeyEvent", "(uint32 7, uint32 0, uint32 0)"),
      WAIT("a", "CommitText"),
      WAIT("a", "UpdatePreeditText"),
      DESTROY("a"),
      NULL,
  };
  JsonArray *records = execute(steps, TRUE);

  JsonObject *event = record(records, 1, "event", 1);
  JsonObject *payload = json_object_get_object_member(event, "payload");
  g_assert_cmpstr(json_object_get_string_member(event, "name"), ==,
                  "UpdatePreeditText");
  g_assert_cmpstr(json_object_get_string_member(payload, "signature"), ==,
                  "(vubu)");
  g_assert_nonnull(
      strstr(json_object_get_string_member(payload, "text"), "''"));
  record(records, 2, "event", 1);
  record(records, 3, "reply", 1);
  record(records, 4, "reply", 2);
  record(records, 5, "reply", 3);
  g_assert_cmpuint(json_array_get_length(records), ==, 7);
  json_array_unref(records);
}

typedef struct {
  const char **steps;
  const char *message;
} ErrorCase;

static void error_case(gconstpointer data) {
  const ErrorCase *test = data;
  JsonArray *records = execute(test->steps, FALSE);

  g_assert_cmpuint(json_array_get_length(records), >, 0);
  JsonObject *last = json_array_get_object_element(
      records, json_array_get_length(records) - 1);
  g_assert_cmpstr(json_object_get_string_member(last, "kind"), ==, "error");
  g_assert_nonnull(
      strstr(json_object_get_string_member(last, "message"), test->message));
  json_array_unref(records);
}

static void dead_engine_case(gconstpointer data) {
  const ErrorCase *test = data;
  JsonArray *records = execute(test->steps, FALSE);
  JsonObject *last = json_array_get_object_element(
      records, json_array_get_length(records) - 1);
  g_assert_cmpstr(json_object_get_string_member(last, "kind"), ==, "error");
  const char *message = json_object_get_string_member(last, "message");
  const char *bus_disconnection =
      "org.freedesktop.DBus.Error.NoReply: Message recipient disconnected "
      "from message bus without replying";
  g_assert_true(strstr(message, "engine connection disappeared") ||
                strstr(message, bus_disconnection));
  json_array_unref(records);
}

static void bus_policy_denial(void) {
  static const char *config =
      "<busconfig>"
      "<type>session</type>"
      "<listen>unix:tmpdir=/tmp</listen>"
      "<auth>EXTERNAL</auth>"
      "<policy context=\"default\">"
      "<allow own=\"*\"/>"
      "<allow send_destination=\"*\" eavesdrop=\"true\"/>"
      "<allow receive_sender=\"*\"/>"
      "<allow eavesdrop=\"true\"/>"
      "<deny send_destination=\"org.example.IBusTest\" "
      "send_interface=\"org.freedesktop.IBus.Engine\" "
      "send_member=\"ProcessKeyEvent\"/>"
      "</policy>"
      "</busconfig>";
  GError *error = NULL;
  char *config_path = NULL;
  int config_fd =
      g_file_open_tmp("ibus-test-bus-policy-XXXXXX", &config_path, &error);
  g_assert_no_error(error);
  g_assert_cmpint(config_fd, >=, 0);
  close(config_fd);
  g_assert_true(g_file_set_contents(config_path, config, -1, &error));
  g_assert_no_error(error);

  GSubprocess *policy_bus = g_subprocess_new(
      G_SUBPROCESS_FLAGS_STDOUT_PIPE | G_SUBPROCESS_FLAGS_STDERR_PIPE, &error,
      "dbus-daemon", "--config-file", config_path, "--nofork",
      "--print-address=1", NULL);
  g_assert_no_error(error);
  GDataInputStream *address_stream =
      g_data_input_stream_new(g_subprocess_get_stdout_pipe(policy_bus));
  Run startup = {.loop = g_main_loop_new(NULL, FALSE), .process = policy_bus};
  guint timer = g_timeout_add(3000, kill_timeout, &startup);
  g_data_input_stream_read_line_async(address_stream, G_PRIORITY_DEFAULT, NULL,
                                      ready, &startup);
  g_main_loop_run(startup.loop);
  if (!startup.timed_out)
    g_source_remove(timer);
  g_main_loop_unref(startup.loop);
  g_assert_false(startup.timed_out);
  g_assert_no_error(startup.error);
  char *address = startup.out;
  g_assert_nonnull(address);
  policy_bus_address = address;
  const char *steps[] = {
      CREATE("a", "fixture"),
      CALL("a", "ProcessKeyEvent", "(uint32 0, uint32 0, uint32 0)"),
      DESTROY("a"),
      NULL,
  };
  JsonArray *records = execute(steps, FALSE);
  policy_bus_address = NULL;
  g_subprocess_force_exit(policy_bus);
  g_subprocess_wait(policy_bus, NULL, NULL);
  g_object_unref(address_stream);
  g_object_unref(policy_bus);
  g_free(address);
  unlink(config_path);
  g_free(config_path);

  g_assert_cmpuint(json_array_get_length(records), ==, 2);
  record(records, 0, "reply", 0);
  JsonObject *last =
      record(records, json_array_get_length(records) - 1, "error", 1);
  g_assert_nonnull(
      strstr(json_object_get_string_member(last, "message"), "AccessDenied"));
  json_array_unref(records);
}

static void failed_creation_output(gconstpointer data) {
  const ErrorCase *test = data;
  JsonArray *records = execute(test->steps, FALSE);

  g_assert_cmpuint(json_array_get_length(records), ==, 6);
  JsonObject *first_event = record(records, 2, "event", 1);
  JsonObject *last_event = record(records, 4, "event", 1);
  g_assert_cmpstr(json_object_get_string_member(first_event, "context"), ==,
                  "a");
  g_assert_cmpstr(json_object_get_string_member(last_event, "context"), ==,
                  "a");
  JsonObject *first_payload =
      json_object_get_object_member(first_event, "payload");
  JsonObject *last_payload =
      json_object_get_object_member(last_event, "payload");
  g_assert_cmpstr(json_object_get_string_member(first_payload, "text"), ==,
                  "(uint32 1, uint32 0, uint32 0)");
  g_assert_cmpstr(json_object_get_string_member(last_payload, "text"), ==,
                  "(uint32 3, uint32 0, uint32 0)");

  JsonObject *unresolved = record(records, 3, "error", 1);
  const char *diagnostic = json_object_get_string_member(unresolved, "message");
  g_assert_nonnull(strstr(diagnostic, "/org/example/unresolved"));
  g_assert_nonnull(strstr(diagnostic, "ForwardKeyEvent"));
  g_assert_nonnull(strstr(diagnostic, "(uuu)"));
  g_assert_nonnull(strstr(diagnostic, "(uint32 2, uint32 0, uint32 0)"));

  JsonObject *terminal = record(records, 5, "error", 1);
  g_assert_nonnull(strstr(json_object_get_string_member(terminal, "message"),
                          test->message));
  json_array_unref(records);
}

int main(int argc, char **argv) {
  adapter_path = argv[1];
  engine_path = argv[2];
  argc = 1;
  g_test_init(&argc, &argv, NULL);
  bus = g_test_dbus_new(G_TEST_DBUS_NONE);
  g_test_dbus_up(bus);

  const ErrorCase unknown_method = {
      TRACE(CREATE("a", "fixture"), CALL("a", "UnknownMethod", "()"),
            DESTROY("a")),
      "UnknownMethod",
  };
  const ErrorCase dead_engine = {
      TRACE(CREATE("a", "fixture"),
            CALL("a", "ProcessKeyEvent", "(uint32 3, uint32 0, uint32 0)"),
            DESTROY("a")),
      "disappeared",
  };
  const ErrorCase unanswered_call = {
      TRACE(CREATE("a", "fixture"),
            CALL("a", "ProcessKeyEvent", "(uint32 5, uint32 0, uint32 0)"),
            DESTROY("a")),
      "deadline exceeded",
  };
  const ErrorCase wait_timeout = {
      TRACE(CREATE("a", "fixture"), WAIT("a", "CommitText"), DESTROY("a")),
      "deadline exceeded",
  };
  const ErrorCase destroyed_signal = {
      TRACE(CREATE("a", "fixture"),
            CALL("a", "ProcessKeyEvent", "(uint32 6, uint32 0, uint32 0)"),
            DESTROY("a")),
      "destroyed engine path",
  };
  const ErrorCase open_context = {TRACE(CREATE("a", "fixture")),
                                  "live contexts"};

  const ErrorCase failed_factory = {
      TRACE(CREATE("a", "early"), CREATE("b", "fail-error"), DESTROY("a"),
            DESTROY("b")),
      "intentional factory failure",
  };
  const ErrorCase timed_out_factory = {
      TRACE(CREATE("a", "early"), CREATE("b", "fail-timeout"), DESTROY("a"),
            DESTROY("b")),
      "checkpoint deadline exceeded",
  };
  const ErrorCase invalid_factory_path = {
      TRACE(CREATE("a", "early"), CREATE("b", "fail-invalid"), DESTROY("a"),
            DESTROY("b")),
      "CreateEngine returned an invalid path",
  };
  const ErrorCase reused_factory_path = {
      TRACE(CREATE("a", "early"), CREATE("b", "fail-reused"), DESTROY("a"),
            DESTROY("b")),
      "CreateEngine reused a live object path",
  };

  g_test_add_data_func("/driver/failed-factory-output", &failed_factory,
                       failed_creation_output);
  g_test_add_data_func("/driver/timed-out-factory-output", &timed_out_factory,
                       failed_creation_output);
  g_test_add_data_func("/driver/invalid-factory-path-output",
                       &invalid_factory_path, failed_creation_output);
  g_test_add_data_func("/driver/reused-factory-path-output",
                       &reused_factory_path, failed_creation_output);
  g_test_add_func("/driver/lifecycle", lifecycle);
  g_test_add_func("/driver/creation-signal", creation_signal);
  g_test_add_func("/driver/interleaved-creation", interleaved_creation);
  g_test_add_func("/driver/empty-and-unmatched-events",
                  empty_and_unmatched_events);
  g_test_add_data_func("/driver/destroyed-path-output", &destroyed_signal,
                       error_case);
  g_test_add_func("/driver/signal-order-unicode-attachments", signal_order);
  g_test_add_func("/driver/two-contexts", contexts);
  g_test_add_func("/driver/content-type", content_type);
  g_test_add_func("/driver/delayed-output", delayed_output);
  g_test_add_func("/driver/trailing-output", trailing);
  g_test_add_data_func("/driver/unknown-method", &unknown_method, error_case);
  g_test_add_func("/driver/bus-policy-denial", bus_policy_denial);
  g_test_add_data_func("/driver/dead-engine", &dead_engine, dead_engine_case);
  g_test_add_data_func("/driver/unanswered-call", &unanswered_call, error_case);
  g_test_add_data_func("/driver/wait-timeout", &wait_timeout, error_case);
  g_test_add_data_func("/driver/open-context-rejected", &open_context,
                       error_case);

  int result = g_test_run();
  g_test_dbus_down(bus);
  g_object_unref(bus);
  return result;
}
