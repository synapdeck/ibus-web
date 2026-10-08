// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: BSD-3-Clause

// Mozc's client library with the converter in the same process: the client
// still speaks its IPC protocol, serializing each command, but the
// "connection" hands the bytes to a SessionHandler, as mozc_server's
// SessionServer::Process would, and no server process is ever started.

#ifndef IBUS_WEB_IN_PROCESS_IN_PROCESS_H_
#define IBUS_WEB_IN_PROCESS_IN_PROCESS_H_

#include <memory>
#include <string>

#include "absl/status/statusor.h"
#include "client/client_interface.h"
#include "ipc/ipc.h"
#include "session/session_handler_interface.h"

namespace ibus_web {

// The desktop engine on the data set at `data_path`.
absl::StatusOr<std::unique_ptr<mozc::SessionHandlerInterface>>
CreateSessionHandler(const std::string &data_path);

// Connections to `handler`, which must outlive the factory and every client
// it makes.
class InProcessIPCClientFactory : public mozc::IPCClientFactoryInterface {
public:
  explicit InProcessIPCClientFactory(mozc::SessionHandlerInterface *handler)
      : handler_(handler) {}

  std::unique_ptr<mozc::IPCClientInterface>
  NewClient(const std::string &name, const std::string &path_name) override;
  std::unique_ptr<mozc::IPCClientInterface>
  NewClient(const std::string &name) override;

private:
  mozc::SessionHandlerInterface *handler_;
};

// mozc::client::Client instances connected to `handler`, for
// mozc::client::ClientFactory::SetClientFactory.
class InProcessClientFactory : public mozc::client::ClientFactoryInterface {
public:
  explicit InProcessClientFactory(mozc::SessionHandlerInterface *handler)
      : ipc_client_factory_(handler) {}

  std::unique_ptr<mozc::client::ClientInterface> NewClient() override;

private:
  InProcessIPCClientFactory ipc_client_factory_;
};

} // namespace ibus_web

#endif // IBUS_WEB_IN_PROCESS_IN_PROCESS_H_
