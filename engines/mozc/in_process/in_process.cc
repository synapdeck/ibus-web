// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: BSD-3-Clause

#include "ibus_web_in_process/in_process.h"

#include <cstdint>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "absl/log/log.h"
#include "absl/status/statusor.h"
#include "absl/strings/string_view.h"
#include "absl/time/time.h"
#include "base/version.h"
#include "client/client.h"
#include "data_manager/data_manager.h"
#include "engine/engine.h"
#include "engine/engine_interface.h"
#include "protocol/commands.pb.h"
#include "session/session_handler.h"

namespace ibus_web {
namespace {

class InProcessIPCClient : public mozc::IPCClientInterface {
public:
  explicit InProcessIPCClient(mozc::SessionHandlerInterface *handler)
      : handler_(handler), product_version_(mozc::Version::GetMozcVersion()) {}

  bool Connected() const override { return handler_->IsAvailable(); }

  bool Call(const std::string &request, std::string *response,
            absl::Duration timeout) override {
    response->clear();

    mozc::commands::Command command;
    if (!command.mutable_input()->ParseFromString(request)) {
      // The server answers an unparsable request with an empty response,
      // which the client then fails to parse as a broken message.
      LOG(WARNING) << "Invalid request";
      last_error_ = mozc::IPC_NO_ERROR;
      return true;
    }

    // A server whose handler refuses a command shuts down, and its client
    // reads no reply.
    if (!handler_->EvalCommand(&command)) {
      LOG(WARNING) << "EvalCommand() returned false";
      last_error_ = mozc::IPC_READ_ERROR;
      return false;
    }

    if (!command.output().SerializeToString(response)) {
      LOG(WARNING) << "SerializeToString() failed";
      response->clear();
    }
    last_error_ = mozc::IPC_NO_ERROR;
    return true;
  }

  uint32_t GetServerProtocolVersion() const override {
    return mozc::IPC_PROTOCOL_VERSION;
  }
  const std::string &GetServerProductVersion() const override {
    return product_version_;
  }
  uint32_t GetServerProcessId() const override { return 0; }
  mozc::IPCErrorType GetLastIPCError() const override { return last_error_; }

private:
  mozc::SessionHandlerInterface *handler_;
  std::string product_version_;
  mozc::IPCErrorType last_error_ = mozc::IPC_NO_ERROR;
};

// The converter is always running, so there is never a server to start,
// stop or wait for.
class InProcessServerLauncher : public mozc::client::ServerLauncherInterface {
public:
  bool StartServer(mozc::client::ClientInterface *client) override {
    return true;
  }
  bool ForceTerminateServer(absl::string_view name) override { return false; }
  bool WaitServer(uint32_t pid) override { return true; }
  void OnFatal(ServerErrorType type) override {
    LOG(ERROR) << "In-process converter failed: " << type;
  }
  void set_server_program(absl::string_view server_program) override {
    server_program_ = std::string(server_program);
  }
  const std::string &server_program() const override { return server_program_; }
  void set_restricted(bool restricted) override {}
  void set_suppress_error_dialog(bool suppress) override {}

private:
  std::string server_program_;
};

// The engine as it is, but for Sync, which the session handler calls to
// write what the engine learned and its user dictionary to the profile
// directory, and which does nothing: another host writes that directory.
class UnsavedEngine : public mozc::EngineInterface {
public:
  explicit UnsavedEngine(std::unique_ptr<mozc::EngineInterface> engine)
      : engine_(std::move(engine)) {}

  mozc::ConverterInterface *GetConverter() const override {
    return engine_->GetConverter();
  }
  absl::string_view GetPredictorName() const override {
    return engine_->GetPredictorName();
  }
  mozc::dictionary::SuppressionDictionary *GetSuppressionDictionary() override {
    return engine_->GetSuppressionDictionary();
  }
  bool Reload() override { return engine_->Reload(); }
  bool Sync() override { return true; }
  bool Wait() override { return engine_->Wait(); }
  bool ReloadAndWait() override { return engine_->ReloadAndWait(); }
  absl::Status ReloadModules(std::unique_ptr<mozc::engine::Modules> modules,
                             bool is_mobile) override {
    return engine_->ReloadModules(std::move(modules), is_mobile);
  }
  mozc::UserDataManagerInterface *GetUserDataManager() override {
    return engine_->GetUserDataManager();
  }
  absl::string_view GetDataVersion() const override {
    return engine_->GetDataVersion();
  }
  const mozc::DataManagerInterface *GetDataManager() const override {
    return engine_->GetDataManager();
  }
  std::vector<std::string> GetPosList() const override {
    return engine_->GetPosList();
  }
  void SetSupplementalModel(const mozc::engine::SupplementalModelInterface
                                *supplemental_model) override {
    engine_->SetSupplementalModel(supplemental_model);
  }
  bool MaybeReloadEngine(mozc::EngineReloadResponse *response) override {
    return engine_->MaybeReloadEngine(response);
  }
  bool
  SendEngineReloadRequest(const mozc::EngineReloadRequest &request) override {
    return engine_->SendEngineReloadRequest(request);
  }

private:
  std::unique_ptr<mozc::EngineInterface> engine_;
};

} // namespace

absl::StatusOr<std::unique_ptr<mozc::SessionHandlerInterface>>
CreateSessionHandler(const std::string &data_path, bool read_only) {
  absl::StatusOr<std::unique_ptr<mozc::DataManager>> data_manager =
      mozc::DataManager::CreateFromFile(data_path);
  if (!data_manager.ok()) {
    return data_manager.status();
  }

  absl::StatusOr<std::unique_ptr<mozc::Engine>> engine =
      mozc::Engine::CreateDesktopEngine(*std::move(data_manager));
  if (!engine.ok()) {
    return engine.status();
  }

  if (read_only) {
    return std::make_unique<mozc::SessionHandler>(
        std::make_unique<UnsavedEngine>(*std::move(engine)));
  }
  return std::make_unique<mozc::SessionHandler>(*std::move(engine));
}

std::unique_ptr<mozc::IPCClientInterface>
InProcessIPCClientFactory::NewClient(const std::string &name,
                                     const std::string &path_name) {
  return std::make_unique<InProcessIPCClient>(handler_);
}

std::unique_ptr<mozc::IPCClientInterface>
InProcessIPCClientFactory::NewClient(const std::string &name) {
  return NewClient(name, "");
}

std::unique_ptr<mozc::client::ClientInterface>
InProcessClientFactory::NewClient() {
  auto client = std::make_unique<mozc::client::Client>();
  client->SetIPCClientFactory(&ipc_client_factory_);
  client->SetServerLauncher(std::make_unique<InProcessServerLauncher>());
  return client;
}

} // namespace ibus_web
