// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

#pragma once

#include <string>
#include <utility>
#include <vector>

#include "../../src/sink.hpp"

namespace ibusweb::table {

// A sink that records each call as a line of text. Candidate lists are
// summarised, so that a trace stays readable; the last list is kept whole
// for tests of its contents.
class Recorder final : public Sink {
public:
  void commit(std::string_view text) override {
    events_.push_back("commit \"" + std::string(text) + "\"");
  }

  void preedit(std::string_view text) override {
    events_.push_back("preedit \"" + std::string(text) + "\"");
  }

  void candidates(std::span<const Candidate> all, std::size_t cursor,
                  bool cursorShown) override {
    last_.assign(all.begin(), all.end());
    if (all.empty()) {
      events_.emplace_back("candidates none");
      return;
    }
    events_.push_back("candidates " + std::to_string(all.size()) + " cursor " +
                      std::to_string(cursor) +
                      (cursorShown ? " shown" : " hidden"));
  }

  // The events since the last call.
  std::vector<std::string> take() { return std::exchange(events_, {}); }

  std::vector<std::string> keys() const {
    std::vector<std::string> keys;
    for (const Candidate &candidate : last_) {
      keys.push_back(candidate.key);
    }
    return keys;
  }

private:
  std::vector<std::string> events_;
  std::vector<Candidate> last_;
};

} // namespace ibusweb::table
