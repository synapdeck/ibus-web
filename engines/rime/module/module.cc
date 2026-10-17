// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: GPL-3.0-or-later

// ibus-rime as a side module: what its main() sets up before it enters
// ibus_main(), without a bus.

#include <cerrno>
#include <cstring>
#include <filesystem>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

#include <glog/logging.h>
#include <leveldb/env.h>
#include <rime/config/config_component.h>
#include <rime/context.h>
#include <rime/deployer.h>
#include <rime/dict/level_db.h>
#include <rime/dict/table_db.h>
#include <rime/dict/text_db.h>
#include <rime/dict/user_db.h>
#include <rime/key_event.h>
#include <rime/registry.h>
#include <rime/resource.h>
#include <rime/schema.h>
#include <rime/service.h>
#include <rime/setup.h>
#include <rime/switcher.h>
#include <rime_api.h>

#include <ibus-web/runtime.h>
#include <ibus.h>

// ibus-rime's rime_config.h has the include guard of librime's
// rime/config.h, which rime/schema.h includes.
#undef RIME_CONFIG_H_
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

// Makes every database it is asked for disabled, so that a dictionary never
// opens it.
template <class Component> class Disabled : public Component {
public:
  auto Create(const std::string &name)
      -> decltype(Component::Create(name)) override {
    auto *db = Component::Create(name);
    db->disable();
    return db;
  }
};

// The user's configuration as the writer last saved it, kept in memory: each
// session saves the schema it selects there.
class UnsavedUserConfig : public rime::Config::Component {
public:
  rime::Config *Create(const std::string &name) override {
    std::unique_ptr<rime::Config> saved(user_.Create(name));
    std::stringstream yaml;
    auto *config = new rime::Config;
    if (saved->SaveToStream(yaml)) {
      config->LoadFromStream(yaml);
    }
    return config;
  }

private:
  rime::ConfigComponent<rime::ConfigLoader, rime::UserConfigResourceProvider>
      user_;
};

void Replace(const char *name, rime::ComponentBase *component) {
  rime::Registry &registry = rime::Registry::instance();
  // Replacing a component outright warns.
  registry.Unregister(name);
  registry.Register(name, component);
}

// A read-only mount refuses every write to the user directory. Opening a
// LevelDB fails at its lock file, Rime schedules a recovery that fails too
// and ends every session when it does, and so on for each new session; a
// session's saved configuration fails to save. So no user dictionary opens
// its database, whatever its class (the stable table, read-only by design,
// stays), and the user's configuration is kept in memory.
void KeepUserDataAsItIs() {
  Replace("userdb", new Disabled<rime::UserDbComponent<rime::LevelDb>>);
  Replace("plain_userdb", new Disabled<rime::UserDbComponent<rime::TextDb>>);
  Replace("tabledb", new Disabled<rime::DbComponent<rime::TableDb>>);
  Replace("user_config", new UnsavedUserConfig);
}

#define IBUSWEB_RIME_SCHEMA_ID(schema_id) schema_id,
const char *const kSchemas[] = {IBUSWEB_RIME_SCHEMAS(IBUSWEB_RIME_SCHEMA_ID)};
#undef IBUSWEB_RIME_SCHEMA_ID

bool Shipped(const std::string &id) {
  for (const char *schema : kSchemas) {
    if (id == schema) {
      return true;
    }
  }
  return false;
}

// What each file Rime compiles from the settings was last compiled with,
// by ibusweb_rime_fingerprint's ids, and under "shared" the shared data the
// last deployment of every schema compiled from. A schema not listed was
// compiled with "*", that deployment's; with neither, an id is as
// prebuilt. The record lies in the user directory's build/, beside the
// compiled files.
std::map<std::string, std::string> compiled;

// What the deployment at work compiles, recorded once it succeeds, and
// whether it compiles every schema, which replaces the whole record.
std::map<std::string, std::string> compiling;
bool compiling_all;

// What each file was to be compiled with when a deployment that compiled it
// failed. A compile that fails once, as in a user directory that can't be
// written, fails each time, and every session a schema notification
// compiles from would start one; so a file isn't compiled again with the
// same settings until the Deploy property starts Rime again.
std::map<std::string, std::string> failed;

std::string BuildPath(const char *name) {
  g_autofree char *path =
      g_build_filename(g_get_home_dir(), "build", name, nullptr);
  return path;
}

void LoadRecord() {
  g_autofree char *contents = nullptr;
  if (!g_file_get_contents(BuildPath("ibus_web_compiled.txt").c_str(),
                           &contents, nullptr, nullptr)) {
    return;
  }
  g_auto(GStrv) lines = g_strsplit(contents, "\n", -1);
  for (char **line = lines; *line != nullptr; line++) {
    g_auto(GStrv) fields = g_strsplit(*line, " ", 2);
    if (g_strv_length(fields) == 2) {
      compiled[fields[0]] = fields[1];
    }
  }
}

void SaveRecord() {
  GString *text = g_string_new(nullptr);
  for (const auto &[id, fingerprint] : compiled) {
    g_string_append_printf(text, "%s %s\n", id.c_str(), fingerprint.c_str());
  }

  g_autoptr(GError) error = nullptr;
  if (g_mkdir_with_parents(BuildPath("").c_str(), 0755) != 0) {
    g_warning("%s: %s", BuildPath("").c_str(), g_strerror(errno));
  } else if (!g_file_set_contents(BuildPath("ibus_web_compiled.txt").c_str(),
                                  text->str, text->len, &error)) {
    g_warning("%s", error->message);
  }
  g_string_free(text, TRUE);
}

std::string Fingerprint(const std::string &id) {
  g_autofree char *fingerprint = ibusweb_rime_fingerprint(id.c_str());
  return fingerprint;
}

bool Stale(const std::string &id) {
  auto found = compiled.find(id);
  if (found == compiled.end() && id != "default" && id != "ibus_rime") {
    found = compiled.find("*");
  }
  if (found != compiled.end()) {
    return found->second != Fingerprint(id);
  }
  g_autofree char *prebuilt = ibusweb_rime_prebuilt_fingerprint();
  return Fingerprint(id) != prebuilt;
}

// Whether id needs compiling: the settings changed it since it was last
// compiled, and its last compile didn't fail with them.
bool Due(const std::string &id) {
  if (!Stale(id)) {
    return false;
  }
  auto found = failed.find(id);
  return found == failed.end() || found->second != Fingerprint(id);
}

// What a deployment that compiles id records it as compiled with: the
// settings, or the prebuilt data's while the schema's dictionary is a
// prebuilt table linked before its data was installed. librime leaves such
// a dictionary's prism as prebuilt, so the schema stays stale, and is
// compiled once an engine that installed the dictionary selects it.
std::string CompiledWith(const std::string &id) {
  rime::the<rime::Config> config(rime::Config::Require("schema")->Create(id));
  std::string dictionary;
  if (config && config->GetString("translator/dictionary", &dictionary)) {
    std::filesystem::path table =
        rime::Service::instance().deployer().prebuilt_data_dir /
        (dictionary + ".table.bin");
    if (std::filesystem::is_symlink(table) && !std::filesystem::exists(table)) {
      g_autofree char *prebuilt = ibusweb_rime_prebuilt_fingerprint();
      return prebuilt;
    }
  }
  return Fingerprint(id);
}

void AddSchema(const char *schema_id, void *data);

void RecordingAll() {
  compiling.clear();
  compiling_all = true;
  for (const char *id : {"*", "default", "ibus_rime"}) {
    compiling[id] = Fingerprint(id);
  }
  compiling["shared"] = kSharedDataDir;

  std::set<std::string> ids;
  for (const char *id : kSchemas) {
    AddSchema(id, &ids);
  }
  for (const std::string &id : ids) {
    compiling[id] = CompiledWith(id);
  }
}

void Recorded(bool ok) {
  if (ok && (compiling_all || !compiling.empty())) {
    if (compiling_all) {
      compiled.clear();
    }
    for (const auto &entry : compiling) {
      compiled[entry.first] = entry.second;
    }
    SaveRecord();
  } else if (!ok) {
    for (const auto &entry : compiling) {
      failed[entry.first] = entry.second;
    }
  }
  compiling.clear();
  compiling_all = false;
}

// Whether Rime must deploy every schema at start: when the shared data
// isn't what it last deployed. librime's own check compares the newest of
// the data directories and their YAML with the time of the last
// deployment, but WasmFS gives a file the time at which it first sees it,
// so every start would look like a change. The shared data is a store
// path, which changes with its contents, and the user directory holds only
// what Rime writes and the module's patches, which reach what is compiled
// as engines select their schemas.
bool Modified() {
  auto shared = compiled.find("shared");
  return shared == compiled.end() || shared->second != kSharedDataDir;
}

// RimeStartMaintenance, with the module's own check for changes.
bool StartMaintenance(bool full_check) {
  rime::LoadModules(rime::kDeployerModules);
  rime::Deployer &deployer = rime::Service::instance().deployer();
  deployer.RunTask("clean_old_log_files");
  if (!deployer.RunTask("installation_update")) {
    return false;
  }
  if (!full_check && !Modified()) {
    return false;
  }

  deployer.ScheduleTask("workspace_update");
  deployer.ScheduleTask("user_dict_upgrade");
  deployer.ScheduleTask("cleanup_trash");
  RecordingAll();
  return deployer.StartMaintenance();
}

// Compiles default.yaml and ibus_rime.yaml where the settings changed them
// since they were last compiled, and of the schemas in ids those the
// settings changed, on the deployer's thread; whether that started. The
// rest wait until an engine selects them.
bool Compile(const std::set<std::string> &ids) {
  rime::LoadModules(rime::kDeployerModules);
  rime::Deployer &deployer = rime::Service::instance().deployer();
  std::vector<std::string> names;
  compiling.clear();
  compiling_all = false;

  for (const char *file : {"default", "ibus_rime"}) {
    if (!Due(file)) {
      continue;
    }
    std::string name = std::string(file) + ".yaml";
    deployer.ScheduleTask(
        "config_file_update",
        rime::TaskInitializer(
            std::pair<std::string, std::string>(name, "config_version")));
    compiling[file] = Fingerprint(file);
    names.push_back(name);
  }

  rime::the<rime::ResourceResolver> sources(
      rime::Service::instance().CreateResourceResolver(
          {"schema_source_file", "", ".schema.yaml"}));
  for (const std::string &id : ids) {
    if (!Due(id)) {
      continue;
    }
    rime::path source = sources->ResolvePath(id);
    if (!std::filesystem::exists(source)) {
      continue;
    }
    deployer.ScheduleTask("schema_update", rime::TaskInitializer(source));
    compiling[id] = CompiledWith(id);
    names.push_back(id);
  }

  if (names.empty()) {
    return false;
  }
  std::string list;
  for (const std::string &name : names) {
    list += (list.empty() ? "" : ", ") + name;
  }
  g_message("Rime compiles %s.", list.c_str());
  return deployer.StartMaintenance();
}

// A schema the module ships, and the schemas it depends on, as its
// compiled config names them.
void AddSchema(const char *schema_id, void *data) {
  auto *ids = static_cast<std::set<std::string> *>(data);
  if (!Shipped(schema_id)) {
    return;
  }

  ids->insert(schema_id);
  rime::the<rime::Config> config(
      rime::Config::Require("schema")->Create(schema_id));
  auto dependencies = config ? config->GetList("schema/dependencies") : nullptr;
  if (!dependencies) {
    return;
  }
  for (auto item = dependencies->begin(); item != dependencies->end(); ++item) {
    if (auto dependency = rime::As<rime::ConfigValue>(*item)) {
      ids->insert(dependency->str());
    }
  }
}

void Start(gboolean full_check) {
  failed.clear();
  rime_api->initialize(&traits);

  // The writer deploys into the user directory, which a read-only module
  // can't; it uses what the writer deployed last.
  if (!ibusweb_user_data_writable()) {
    KeepUserDataAsItIs();
    g_message("Rime is ready.");
    return;
  }

  if (StartMaintenance(full_check)) {
    rime_api->deploy_config_file("ibus_rime.yaml", "config_version");
  } else if (!Compile({})) {
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
  Recorded(deployed_ok);

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

// The page size the page stored, or else the schema's own, which a reset
// brings back. A schema reads its page size once, when it is loaded, and
// the menu reads it from the schema, so setting it reaches the session at
// its next lookup table without compiling any config.
void ApplyPageSize(RimeSessionId session_id, void *) {
  auto session = rime::Service::instance().GetSession(session_id);
  rime::Schema *schema = session ? session->schema() : nullptr;
  if (!schema) {
    return;
  }

  int page_size = ibusweb_rime_page_size();
  if (page_size <= 0 &&
      !(schema->config() &&
        schema->config()->GetInt("menu/page_size", &page_size) &&
        page_size > 0)) {
    page_size = 5;
  }
  schema->set_page_size(page_size);
}

void Notify(void *, RimeSessionId session_id, const char *message_type,
            const char *message_value) {
  if (std::strcmp(message_type, "option") == 0) {
    ibus_rime_engine_option_changed(session_id, message_value);
    return;
  }
  // A session has selected a schema: the engine's own as it is made, or
  // after a deployment ended its last session. Its engine's dictionaries
  // are installed by then, so this is when a schema left stale by a
  // settings change, or by a deployment that came before its dictionaries,
  // is compiled; the session works with what it has until the deployment
  // ends it.
  if (std::strcmp(message_type, "schema") == 0) {
    ApplyPageSize(session_id, nullptr);
    if (!ibusweb_rime_deploying()) {
      std::set<std::string> ids;
      std::string schema_id(message_value);
      AddSchema(schema_id.substr(0, schema_id.find('/')).c_str(), &ids);
      Compile(ids);
    }
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
// that a Backspace can take it back, until the session's next key; ending
// the Worker loses it. Persist ends it as a key no processor handles does,
// telling the session's listeners of a key with no symbol, which in the
// shipped schemas only the learning acts on.
void FinishLearning(RimeSessionId session_id, void *) {
  auto session = rime::Service::instance().GetSession(session_id);
  if (!session) {
    return;
  }
  rime::Context *context = session->context();
  context->unhandled_key_notifier()(context,
                                    rime::KeyEvent(IBUS_KEY_VoidSymbol, 0));
}

void ArmIdle();

// A user dictionary's log, which LevelDB appends to as Rime learns, during
// a key. On the IndexedDB backend a write can wait for the page, which is
// spinning on that key's reply: WebKit reaches IndexedDB from a Worker only
// through the page's main thread. What the pumping thread writes stays in
// the file's buffer until input pauses or the page asks for Persist. Other
// threads, which handle no keys, write through.
//
// LevelDB was told a held write succeeded, so one that fails later is kept
// and returned from every later call: the records it held are lost, and the
// log's blocks no longer line up after them, so nothing more is written to
// it. The next write fails as a write that failed during a key would.
class HeldLog : public leveldb::WritableFile {
public:
  explicit HeldLog(leveldb::WritableFile *file);
  ~HeldLog() override;

  leveldb::Status Append(const leveldb::Slice &data) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!failed_.ok()) {
      return failed_;
    }
    return file_->Append(data);
  }

  leveldb::Status Flush() override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!failed_.ok()) {
      return failed_;
    }
    if (g_main_context_is_owner(g_main_context_default())) {
      held_ = true;
      ArmIdle();
      return leveldb::Status::OK();
    }
    held_ = false;
    return file_->Flush();
  }

  leveldb::Status Sync() override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!failed_.ok()) {
      return failed_;
    }
    held_ = false;
    return file_->Sync();
  }

  leveldb::Status Close() override {
    std::lock_guard<std::mutex> lock(mutex_);
    held_ = false;
    leveldb::Status closed = file_->Close();
    return failed_.ok() ? closed : failed_;
  }

  // Writes out what Flush held back. Another thread writing to the file
  // meanwhile writes it out itself, so a busy file is passed over rather
  // than waited for: that thread's I/O can need the pumping thread.
  void Release() {
    std::unique_lock<std::mutex> lock(mutex_, std::try_to_lock);
    if (!lock.owns_lock() || !held_) {
      return;
    }
    held_ = false;
    leveldb::Status status = file_->Flush();
    if (!status.ok()) {
      failed_ = status;
      g_warning("Rime's user dictionary log wasn't written: %s",
                status.ToString().c_str());
    }
  }

private:
  std::mutex mutex_;
  leveldb::WritableFile *file_;
  bool held_ = false;
  leveldb::Status failed_;
};

std::mutex held_logs_mutex;
std::set<HeldLog *> held_logs;

HeldLog::HeldLog(leveldb::WritableFile *file) : file_(file) {
  std::lock_guard<std::mutex> lock(held_logs_mutex);
  held_logs.insert(this);
}

HeldLog::~HeldLog() {
  {
    std::lock_guard<std::mutex> lock(held_logs_mutex);
    held_logs.erase(this);
  }
  delete file_;
}

void ReleaseLogs() {
  std::lock_guard<std::mutex> lock(held_logs_mutex);
  for (HeldLog *log : held_logs) {
    log->Release();
  }
}

class HoldingEnv : public leveldb::EnvWrapper {
public:
  HoldingEnv() : EnvWrapper(leveldb::Env::Default()) {}

  leveldb::Status NewWritableFile(const std::string &name,
                                  leveldb::WritableFile **file) override {
    return Hold(name, target()->NewWritableFile(name, file), file);
  }

  leveldb::Status NewAppendableFile(const std::string &name,
                                    leveldb::WritableFile **file) override {
    return Hold(name, target()->NewAppendableFile(name, file), file);
  }

private:
  // Only a database's log is written while a key is handled; its tables and
  // manifest are written on opening it and by compaction.
  static leveldb::Status Hold(const std::string &name, leveldb::Status status,
                              leveldb::WritableFile **file) {
    if (status.ok() && g_str_has_suffix(name.c_str(), ".log")) {
      *file = new HeldLog(*file);
    }
    return status;
  }
};

void Persist() {
  ibus_rime_engine_foreach_session(FinishLearning, nullptr);
  ReleaseLogs();
}

// How long input pauses before the learning is written: past the 3 s in
// which a Backspace takes a commit's learning back, which Rime counts in
// whole seconds of the clock and so can stretch to just under 4. A key that
// arrives while the write waits on the page waits too, so the write waits
// for a pause rather than coming at a fixed time after a commit.
constexpr gint64 kIdleUs = 5 * G_USEC_PER_SEC;

gint64 last_input;
guint idle_source;

gboolean Idle(gpointer) {
  gint64 idle_for = g_get_monotonic_time() - last_input;
  if (idle_for < kIdleUs) {
    idle_source = g_timeout_add((kIdleUs - idle_for) / 1000 + 1, Idle, nullptr);
    return G_SOURCE_REMOVE;
  }

  // A write Persist holds back is released with the rest, so it arms no
  // other pause while this one runs.
  Persist();
  idle_source = 0;
  return G_SOURCE_REMOVE;
}

void ArmIdle() {
  if (idle_source == 0) {
    idle_source = g_timeout_add(kIdleUs / 1000, Idle, nullptr);
  }
}

// Any engine's key or candidate click holds the page as Rime's do, and a
// commit, whose learning the pause writes, comes from one.
gboolean Input(GSignalInvocationHint *, guint, const GValue *, gpointer) {
  last_input = g_get_monotonic_time();
  ArmIdle();
  return TRUE;
}

} // namespace

extern "C" void ibusweb_rime_compile_open(void) {
  std::set<std::string> ids;
  ibus_rime_engine_foreach_schema(AddSchema, &ids);
  Compile(ids);
}

extern "C" void ibusweb_rime_page_size_changed(void) {
  ibus_rime_engine_foreach_session(ApplyPageSize, nullptr);
}

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

// The traits, engines, settings and LevelDB environment live as long as the
// module, which is the Worker's lifetime, so none is freed and Rime is
// finalized only to restart.
void ibusweb_module_init(IBusWebModule *module) {
  ibusweb_module_set_persist(module, Persist);

  rime::LevelDb::SetEnv(new HoldingEnv);
  g_type_class_ref(IBUS_TYPE_ENGINE);
  for (const char *signal : {"process-key-event", "candidate-clicked"}) {
    g_signal_add_emission_hook(g_signal_lookup(signal, IBUS_TYPE_ENGINE), 0,
                               Input, nullptr, nullptr);
  }

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
  LoadRecord();
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
