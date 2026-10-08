// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

#include <string>
#include <utility>

#include "composition.hpp"
#include "keys.hpp"
#include "utf8.hpp"

namespace ibusweb::table {

namespace {

// A composition opened by the trigger and ended explicitly: a candidate or
// the raw buffer is committed, or Backspace deletes the trigger.
class CommandSession final : public Session {
public:
  CommandSession(const Table &table, Sink &sink)
      : table_(table), sink_(sink), trigger_(*table.frontmatter().trigger) {}

  bool processKey(std::uint32_t keyval, char32_t character,
                  std::uint32_t modifiers) override {
    if (isInert(keyval, modifiers)) {
      return false;
    }
    if ((modifiers & masks::passThrough) != 0) {
      if (composing()) {
        finish(buffer_);
      }
      return false;
    }
    if (!composing()) {
      return idle(character);
    }

    switch (keyval) {
    case keys::Return:
    case keys::KP_Enter:
      finish(chosen());
      return true;
    case keys::space:
    case keys::KP_Space:
      if (candidates_.highlighted() != nullptr) {
        finish(chosen());
        return true;
      }
      finish(buffer_);
      return false;
    case keys::Escape:
      finish(buffer_);
      return true;
    case keys::BackSpace:
      backspace();
      return true;
    case keys::Up:
    case keys::KP_Up:
    case keys::ISO_Left_Tab:
      cursorUp();
      return true;
    case keys::Down:
    case keys::KP_Down:
      cursorDown();
      return true;
    case keys::Tab:
    case keys::KP_Tab:
      if ((modifiers & masks::Shift) != 0) {
        cursorUp();
      } else {
        cursorDown();
      }
      return true;
    case keys::Page_Up:
      pageUp();
      return true;
    case keys::Page_Down:
      pageDown();
      return true;
    default:
      break;
    }

    if (isPrintable(character) && table_.inAlphabet(character)) {
      utf8::append(buffer_, character);
      update();
      return true;
    }
    if (isPrintable(character)) {
      finish(chosen());
      return idle(character);
    }

    // Keys that type nothing (Left, Home, Delete, F1, …) act on the text
    // around the composition, so it is committed first.
    finish(buffer_);
    return false;
  }

  void candidateClicked(std::size_t index) override {
    if (const Candidate *candidate = candidates_.at(index)) {
      finish(candidate->output);
    }
  }

  void pageUp() override {
    candidates_.showIfChanged(candidates_.pageUp(), sink_);
  }

  void pageDown() override {
    candidates_.showIfChanged(candidates_.pageDown(), sink_);
  }

  void cursorUp() override {
    candidates_.showIfChanged(candidates_.cursorUp(), sink_);
  }

  void cursorDown() override {
    candidates_.showIfChanged(candidates_.cursorDown(), sink_);
  }

  void reset() override {
    buffer_.clear();
    candidates_.clear();
  }

private:
  bool composing() const { return !buffer_.empty(); }

  bool idle(char32_t character) {
    if (character != trigger_) {
      return false;
    }
    utf8::append(buffer_, character);
    update();
    return true;
  }

  // The highlighted candidate's output if the cursor is shown, otherwise the
  // raw buffer.
  std::string chosen() const {
    const Candidate *candidate = candidates_.highlighted();
    return candidate != nullptr ? candidate->output : buffer_;
  }

  void update() {
    // The exact match, if any, is the shortest completion, so it comes first.
    const bool exact = !table_.exact(buffer_).empty();
    candidates_.set(table_.completions(buffer_), exact);
    sink_.preedit(buffer_);
    candidates_.show(sink_);
  }

  void backspace() {
    buffer_.resize(buffer_.size() - utf8::lastLength(buffer_));
    if (composing()) {
      update();
      return;
    }
    candidates_.clear();
    hide();
  }

  // Takes its text by value: it is often the buffer, which this clears.
  void finish(std::string text) {
    buffer_.clear();
    candidates_.clear();
    sink_.commit(text);
    hide();
  }

  void hide() {
    sink_.preedit("");
    candidates_.show(sink_);
  }

  const Table &table_;
  Sink &sink_;
  char32_t trigger_;
  std::string buffer_;
  CandidateList candidates_;
};

} // namespace

std::unique_ptr<Session> makeCommandSession(const Table &table, Sink &sink) {
  return std::make_unique<CommandSession>(table, sink);
}

} // namespace ibusweb::table
