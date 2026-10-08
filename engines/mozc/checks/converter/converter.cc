// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: BSD-3-Clause

// Types romaji into a Mozc session, converts it and prints each step's
// preedit and the committed result: the converter, its data set and the
// session layer working in-process, with no server.

#include <cstdlib>
#include <iostream>
#include <memory>
#include <string>
#include <utility>

#include "base/system_util.h"
#include "data_manager/data_manager.h"
#include "engine/engine.h"
#include "protocol/commands.pb.h"
#include "session/session_handler.h"

namespace {

using ::mozc::commands::Command;
using ::mozc::commands::Input;
using ::mozc::commands::KeyEvent;
using ::mozc::commands::SessionCommand;

std::string Preedit(const Command &command) {
  std::string text;
  for (const auto &segment : command.output().preedit().segment()) {
    text += segment.value();
  }
  return text;
}

bool Eval(mozc::SessionHandler &handler, Command &command) {
  if (!handler.EvalCommand(&command)) {
    std::cerr << "EvalCommand failed: " << command.input().DebugString();
    return false;
  }
  return true;
}

bool SendKey(mozc::SessionHandler &handler, uint64_t id, const KeyEvent &key,
             Command &command) {
  command.Clear();
  command.mutable_input()->set_type(Input::SEND_KEY);
  command.mutable_input()->set_id(id);
  *command.mutable_input()->mutable_key() = key;
  return Eval(handler, command);
}

} // namespace

int main(int argc, char **argv) {
  if (argc != 4) {
    std::cerr << "usage: " << argv[0] << " DATA PROFILE ROMAJI\n";
    return EXIT_FAILURE;
  }

  mozc::SystemUtil::SetUserProfileDirectory(argv[2]);

  auto data_manager = mozc::DataManager::CreateFromFile(argv[1]);
  if (!data_manager.ok()) {
    std::cerr << "data set: " << data_manager.status() << "\n";
    return EXIT_FAILURE;
  }
  auto engine = mozc::Engine::CreateDesktopEngine(*std::move(data_manager));
  if (!engine.ok()) {
    std::cerr << "engine: " << engine.status() << "\n";
    return EXIT_FAILURE;
  }
  mozc::SessionHandler handler(*std::move(engine));

  Command command;
  command.mutable_input()->set_type(Input::CREATE_SESSION);
  if (!Eval(handler, command))
    return EXIT_FAILURE;
  const uint64_t id = command.output().id();

  command.Clear();
  command.mutable_input()->set_type(Input::SEND_COMMAND);
  command.mutable_input()->set_id(id);
  command.mutable_input()->mutable_command()->set_type(
      SessionCommand::TURN_ON_IME);
  if (!Eval(handler, command))
    return EXIT_FAILURE;

  KeyEvent key;
  for (const char c : std::string(argv[3])) {
    key.Clear();
    key.set_key_code(static_cast<unsigned char>(c));
    if (!SendKey(handler, id, key, command))
      return EXIT_FAILURE;
  }
  std::cout << "composition: " << Preedit(command) << "\n";

  key.Clear();
  key.set_special_key(KeyEvent::SPACE);
  if (!SendKey(handler, id, key, command))
    return EXIT_FAILURE;
  std::cout << "conversion: " << Preedit(command) << "\n";

  key.Clear();
  key.set_special_key(KeyEvent::ENTER);
  if (!SendKey(handler, id, key, command))
    return EXIT_FAILURE;
  std::cout << "result: " << command.output().result().value() << "\n";

  command.Clear();
  command.mutable_input()->set_type(Input::DELETE_SESSION);
  command.mutable_input()->set_id(id);
  return Eval(handler, command) ? EXIT_SUCCESS : EXIT_FAILURE;
}
