// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: GPL-3.0-or-later

// ibus-rime as a side module: what its main() sets up before it enters
// ibus_main(), without a bus.

#include <cstring>
#include <string>

#include <glog/logging.h>
#include <rime/context.h>
#include <rime/deployer.h>
#include <rime/key_event.h>
#include <rime/service.h>
#include <rime/switcher.h>
#include <rime_api.h>

#include <ibus-web/runtime.h>
#include <ibus.h>

extern "C" {
#include "rime_config.h"
#include "rime_engine.h"
#include "rime_settings.h"
}

#include "rime-tables.h"
#include "settings.h"

extern "C" RimeApi *rime_api;
RimeApi *rime_api = nullptr;

// Keeps the compiled schemas, which the module's settings metadata lists,
// in the side module's data closure.
extern "C" const char ibusweb_rime_settings_schema_dir[] =
    IBUSWEB_SETTINGS_SCHEMA_DIR;

// A static librime registers a plugin's modules only if something refers to
// the plugin; these are what each defines for that.
void rime_require_module_lua();
void rime_require_module_grammar();
void rime_require_module_octagram();

namespace {

// The common data's store path, compiled in so that it stays in the side
// module's data closure; Rime's shared data directory.
constexpr char kSharedDataDir[] = IBUSWEB_RIME_SHARED_DATA_DIR;

RimeTraits traits;

// Rime logs through glog. Its messages become GLib's, which reach the page
// as Log records, and its warnings and errors fail the tests that watch
// for them.
class GLibSink : public google::LogSink {
public:
  void send(google::LogSeverity severity, const char *,
            const char *base_filename, int line, const google::LogMessageTime &,
            const char *message, size_t message_len) override {
    GLogLevelFlags level = G_LOG_LEVEL_INFO;
    if (severity >= google::GLOG_ERROR) {
      level = G_LOG_LEVEL_CRITICAL;
    } else if (severity == google::GLOG_WARNING) {
      level = G_LOG_LEVEL_WARNING;
    }
    g_log("Rime", level, "%s:%d: %.*s", base_filename, line,
          static_cast<int>(message_len), message);
  }
};

// What the last deployment to end reported, and the source that waits on
// the pumping thread for the deployer to return.
bool deployed_ok;
guint returned_source;

// A Deploy that came while the deployer worked, which restarts Rime once it
// has returned, and the check its restart asked for.
bool restart_requested;
gboolean restart_full_check;

void Start(gboolean full_check) {
  rime_api->initialize(&traits);
  if (rime_api->start_maintenance(full_check)) {
    rime_api->deploy_config_file("ibus_rime.yaml", "config_version");
  } else {
    // Nothing changed since the last deployment, so none starts and
    // nothing else would say Rime can be used.
    g_message("Rime is ready.");
  }
}

void Stop() {
  ibus_rime_engine_forget_sessions();
  rime_api->finalize();
}

// The deployer reports a deployment's end before it checks for tasks queued
// meanwhile and returns. Until it has returned, a deployment started here
// would find it still at work and never run, so the end is handled only
// once it has.
gboolean Returned(gpointer) {
  if (ibusweb_rime_deploying()) {
    return G_SOURCE_CONTINUE;
  }
  returned_source = 0;

  if (restart_requested) {
    restart_requested = false;
    Stop();
    Start(restart_full_check);
    ibusweb_rime_settings_deployed();
    return G_SOURCE_REMOVE;
  }

  if (deployed_ok) {
    g_message("Rime is ready.");
    ibus_rime_load_settings();
  } else {
    g_warning("Rime has encountered an error.");
  }

  // Sessions keep the configs they were made with. Ending them makes each
  // engine start a new one, with the deployed configs, at its next key.
  ibus_rime_engine_forget_sessions();
  rime_api->cleanup_all_sessions();
  ibusweb_rime_settings_deployed();
  return G_SOURCE_REMOVE;
}

// Runs on the pumping thread for each deployment's report.
gboolean Deployed(gpointer data) {
  deployed_ok = GPOINTER_TO_INT(data);
  if (returned_source == 0) {
    returned_source = g_timeout_add(10, Returned, nullptr);
  }
  return G_SOURCE_REMOVE;
}

void Notify(void *, RimeSessionId session_id, const char *message_type,
            const char *message_value) {
  if (std::strcmp(message_type, "option") == 0) {
    ibus_rime_engine_option_changed(session_id, message_value);
    return;
  }
  if (std::strcmp(message_type, "deploy") != 0) {
    return;
  }

  // Deployments report from the deployer's thread.
  if (std::strcmp(message_value, "start") == 0) {
    g_message("Rime is under maintenance ...");
  } else if (std::strcmp(message_value, "success") == 0) {
    g_main_context_invoke(nullptr, Deployed, GINT_TO_POINTER(TRUE));
  } else if (std::strcmp(message_value, "failure") == 0) {
    g_main_context_invoke(nullptr, Deployed, GINT_TO_POINTER(FALSE));
  }
}

// A commit's learning stays in its user dictionary's open transaction, so
// that a Backspace can take it back, until the session's next key that no
// processor handles; ending the Worker loses it. Persist ends it as such a
// key does, telling the session's listeners of a key with no symbol, which
// in the shipped schemas only the learning acts on.
void FinishLearning(RimeSessionId session_id, void *) {
  auto session = rime::Service::instance().GetSession(session_id);
  if (!session) {
    return;
  }
  rime::Context *context = session->context();
  context->unhandled_key_notifier()(context,
                                    rime::KeyEvent(IBUS_KEY_VoidSymbol, 0));
}

void Persist() { ibus_rime_engine_foreach_session(FinishLearning, nullptr); }

} // namespace

extern "C" gboolean ibusweb_rime_deploying(void) {
  return rime::Service::instance().deployer().IsWorking();
}

// ibus-rime's Deploy stops Rime and starts it again. RimeFinalize blocks
// until the deployer returns, which would hold the pumping thread for the
// rest of a deployment and handle that deployment's end after the restart
// had begun; while the deployer works, the restart waits for it instead.
extern "C" void ibus_rime_stop() {
  if (ibusweb_rime_deploying()) {
    restart_requested = true;
    return;
  }
  Stop();
}

extern "C" void ibus_rime_start(gboolean full_check) {
  if (restart_requested) {
    restart_full_check = full_check;
    return;
  }
  Start(full_check);
}

// The traits, engines and settings live as long as the module, which is the
// Worker's lifetime, so none is freed and Rime is finalized only to restart.
void ibusweb_module_init(IBusWebModule *module) {
  ibusweb_module_set_persist(module, Persist);

  rime_require_module_lua();
  rime_require_module_grammar();
  rime_require_module_octagram();
  rime_api = rime_get_api();

  RIME_STRUCT_INIT(RimeTraits, traits);
  traits.shared_data_dir = kSharedDataDir;
  traits.user_data_dir = g_get_home_dir();
  traits.log_dir = "";
  traits.distribution_name = "Rime";
  traits.distribution_code_name = "ibus-rime";
  traits.distribution_version = IBUS_RIME_VERSION;
  traits.app_name = "rime.ibus";

  ibusweb_rime_settings_init();
  rime_api->set_notification_handler(Notify, nullptr);
  rime_api->setup(&traits);

  // Setup sent everything to stderr; the sink takes it instead.
  FLAGS_logtostderr = false;
  FLAGS_stderrthreshold = google::NUM_SEVERITIES;
  google::AddLogSink(new GLibSink);

  // The page's picker switches schemas. Switching inside Rime to one whose
  // data this Worker hasn't installed would fail, so Rime's menu offers
  // only the session's own schema, which it lists whatever the filter
  // says, and a new session starts with no schema until the engine selects
  // its own.
  rime::Switcher::SetSchemaListFilter(
      [](const std::string &) { return false; });

  ibus_rime_start(FALSE);
  ibus_rime_load_settings();

  // The factory has no bus connection and the runtime's registry keeps it,
  // so the module drops its own reference once the engines are added.
  IBusFactory *factory =
      IBUS_FACTORY(g_object_ref_sink(ibus_factory_new(nullptr)));
#define IBUSWEB_RIME_ADD_ENGINE(schema_id)                                     \
  ibus_factory_add_engine(factory, "rime:" schema_id, IBUS_TYPE_RIME_ENGINE);
  IBUSWEB_RIME_SCHEMAS(IBUSWEB_RIME_ADD_ENGINE)
#undef IBUSWEB_RIME_ADD_ENGINE
  g_object_unref(factory);
}
