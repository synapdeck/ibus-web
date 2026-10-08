// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

#include <string>
#include <utility>

#include "composition.hpp"
#include "keys.hpp"
#include "utf8.hpp"

namespace ibusweb::table {

namespace {

// Alphabet characters convert as they are typed. Only what could still
// become a longer key stays pending, as the preedit.
class ContinuousSession final : public Session {
public:
  ContinuousSession(const Table &table, Sink &sink)
      : table_(table), sink_(sink) {}

  bool processKey(std::uint32_t keyval, char32_t character,
                  std::uint32_t modifiers) override {
    if (isInert(keyval, modifiers)) {
      return false;
    }

    const bool plain = (modifiers & masks::passThrough) == 0;
    if (plain && keyval == keys::BackSpace) {
      if (buffer_.empty()) {
        return false;
      }
      // Every prefix of a pending buffer can still extend, so nothing
      // resolves.
      buffer_.resize(buffer_.size() - utf8::lastLength(buffer_));
      show();
      return true;
    }
    if (plain && keyval == keys::Escape && !buffer_.empty()) {
      // Commits what the preedit shows, as blur does.
      const std::string raw = std::move(buffer_);
      buffer_.clear();
      sink_.commit(raw);
      show();
      return true;
    }
    if (plain && isPrintable(character) && table_.inAlphabet(character)) {
      utf8::append(buffer_, character);
      resolve(false);
      return true;
    }

    if (!buffer_.empty()) {
      resolve(true);
    }
    return false;
  }

  void candidateClicked(std::size_t index) override {
    const Candidate *candidate = candidates_.at(index);
    if (candidate == nullptr) {
      return;
    }
    const std::string output = candidate->output;
    buffer_.clear();
    sink_.commit(output);
    show();
  }

  void pageUp() override {
    candidates_.showIfChanged(candidates_.pageUp(), sink_);
  }

  void pageDown() override {
    candidates_.showIfChanged(candidates_.pageDown(), sink_);
  }

  // The candidates are a guide to what the buffer can still become; they
  // have no cursor to move.
  void cursorUp() override {}
  void cursorDown() override {}

  void reset() override {
    buffer_.clear();
    candidates_.clear();
    visible_ = false;
  }

private:
  // Commits from the front of the buffer while it can't extend, or until it
  // is empty when flushing: the longest key it starts with, otherwise its
  // first character as typed.
  void resolve(bool flush) {
    std::string out;
    while (!buffer_.empty() && (flush || !table_.extendable(buffer_))) {
      std::size_t consumed = 0;
      if (const auto match = table_.longestPrefix(buffer_)) {
        consumed = match->first;
        out += match->second;
      } else {
        consumed = utf8::decode(buffer_, 0)->length;
        out.append(buffer_, 0, consumed);
      }
      buffer_.erase(0, consumed);
    }

    if (!out.empty()) {
      sink_.commit(out);
    }
    show();
  }

  void show() {
    if (!buffer_.empty()) {
      candidates_.set(table_.completions(buffer_), false);
      sink_.preedit(buffer_);
      candidates_.show(sink_);
      visible_ = true;
      return;
    }

    candidates_.clear();
    if (visible_) {
      sink_.preedit("");
      candidates_.show(sink_);
      visible_ = false;
    }
  }

  const Table &table_;
  Sink &sink_;
  std::string buffer_;
  CandidateList candidates_;
  // Whether the preedit and candidates are on screen, so that emptying an
  // already empty buffer emits nothing.
  bool visible_ = false;
};

} // namespace

std::unique_ptr<Session> makeContinuousSession(const Table &table, Sink &sink) {
  return std::make_unique<ContinuousSession>(table, sink);
}

} // namespace ibusweb::table
