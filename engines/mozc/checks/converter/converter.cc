// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: BSD-3-Clause

// Types romaji into a Mozc session, converts it and prints each step's
// preedit and the committed result. It goes through Mozc's own client
// library, as ibus-mozc does, connected to the converter in this process.

#include <cstdlib>
#include <iostream>
#include <memory>
#include <string>

#include "base/system_util.h"
#include "client/client.h"
#include "ibus_web_in_process/in_process.h"
#include "protocol/commands.pb.h"

namespace {

using ::mozc::commands::KeyEvent;
using ::mozc::commands::Output;
using ::mozc::commands::SessionCommand;

std::string Preedit(const Output &output) {
  std::string text;
  for (const auto &segment : output.preedit().segment()) {
    text += segment.value();
  }
  return text;
}

} // namespace

int main(int argc, char **argv) {
  if (argc != 4) {
    std::cerr << "usage: " << argv[0] << " DATA PROFILE ROMAJI\n";
    return EXIT_FAILURE;
  }

  mozc::SystemUtil::SetUserProfileDirectory(argv[2]);

  auto handler = ibus_web::CreateSessionHandler(argv[1]);
  if (!handler.ok()) {
    std::cerr << "converter: " << handler.status() << "\n";
    return EXIT_FAILURE;
  }
  ibus_web::InProcessClientFactory factory(handler->get());
  mozc::client::ClientFactory::SetClientFactory(&factory);

  std::unique_ptr<mozc::client::ClientInterface> client =
      mozc::client::ClientFactory::NewClient();
  if (!client->EnsureConnection()) {
    std::cerr << "EnsureConnection failed\n";
    return EXIT_FAILURE;
  }

  Output output;
  SessionCommand command;
  command.set_type(SessionCommand::TURN_ON_IME);
  if (!client->SendCommand(command, &output)) {
    std::cerr << "TURN_ON_IME failed\n";
    return EXIT_FAILURE;
  }

  KeyEvent key;
  for (const char c : std::string(argv[3])) {
    key.Clear();
    key.set_key_code(static_cast<unsigned char>(c));
    if (!client->SendKey(key, &output)) {
      std::cerr << "SendKey failed\n";
      return EXIT_FAILURE;
    }
  }
  std::cout << "composition: " << Preedit(output) << "\n";

  key.Clear();
  key.set_special_key(KeyEvent::SPACE);
  if (!client->SendKey(key, &output)) {
    std::cerr << "SendKey failed\n";
    return EXIT_FAILURE;
  }
  std::cout << "conversion: " << Preedit(output) << "\n";

  key.Clear();
  key.set_special_key(KeyEvent::ENTER);
  if (!client->SendKey(key, &output)) {
    std::cerr << "SendKey failed\n";
    return EXIT_FAILURE;
  }
  std::cout << "result: " << output.result().value() << "\n";

  // The client deletes its session when destroyed, through the converter,
  // so it goes first.
  client.reset();
  mozc::client::ClientFactory::SetClientFactory(nullptr);
  return EXIT_SUCCESS;
}
