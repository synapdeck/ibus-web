// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: BSD-3-Clause

// Mozc as a side module: what ibus-mozc's main() sets up before it enters
// ibus_main(), with the converter in this process instead of mozc_server.

#include <memory>
#include <string>

#include "absl/flags/declare.h"
#include "absl/flags/flag.h"
#include "absl/status/statusor.h"
#include "base/system_util.h"
#include "client/client.h"
#include "ibus_web_in_process/in_process.h"
#include "ibus_web_module/settings.h"
#include "session/session_handler_interface.h"
#include "unix/ibus/engine_registrar.h"
#include "unix/ibus/ibus_config.h"
#include "unix/ibus/mozc_engine.h"

#include <ibus-web/runtime.h>
#include <ibus.h>

ABSL_DECLARE_FLAG(bool, use_mozc_renderer);

namespace {

// A store path, compiled in so that the data set stays in the side
// module's data closure.
constexpr char kDataFile[] = "@dataFile@";

// Why the converter didn't load, or empty if it did.
std::string *failure;

// Every engine is made through this handler, which runs before the
// factory's own. Without a converter it fails the CreateEngine, which also
// stops the emission, so no engine is made.
IBusEngine *CreateEngine(IBusFactory *, const gchar *, gpointer) {
  if (!failure->empty()) {
    ibusweb_factory_fail_create(failure->c_str());
  }
  return nullptr;
}

} // namespace

// Keeps the compiled panel schema, which the module's settings metadata
// lists, in the side module's data closure.
extern "C" const char ibusweb_mozc_settings_schema_dir[] =
    "@settingsSchemaDir@";

// The handler, client factory, settings and engine live as long as the
// module, which is the Worker's lifetime, so none is ever freed.
void ibusweb_module_init(IBusWebModule *) {
  // Mozc has no profile directory of its own under WebAssembly; the host
  // makes the module's own files its home.
  mozc::SystemUtil::SetUserProfileDirectory(g_get_home_dir());

  // The candidate window is the page's, drawn from IBus's lookup table.
  absl::SetFlag(&FLAGS_use_mozc_renderer, false);

  failure = new std::string;
  GType type = IBUS_TYPE_ENGINE;
  absl::StatusOr<std::unique_ptr<mozc::SessionHandlerInterface>> handler =
      ibus_web::CreateSessionHandler(kDataFile);
  if (handler.ok()) {
    mozc::client::ClientFactory::SetClientFactory(
        new ibus_web::InProcessClientFactory(handler->release()));

    GSettings *settings = g_settings_new("org.freedesktop.ibus.engine.mozc");
    ibus_web::FollowSettings(settings);
    ibus_web::ApplyLaunchSetting(settings);

    type = mozc::ibus::RegisterEngine(new mozc::ibus::MozcEngine);
  } else {
    *failure = std::string(handler.status().message());
  }

  mozc::IbusConfig config;
  config.Initialize();

  IBusFactory *factory = ibus_factory_new(nullptr);
  g_object_ref_sink(factory);
  g_signal_connect(factory, "create-engine", G_CALLBACK(CreateEngine), nullptr);
  for (const mozc::ibus::Engine &engine : config.GetConfig().engines()) {
    ibus_factory_add_engine(factory, engine.name().c_str(), type);
  }
  g_object_unref(factory);
}
