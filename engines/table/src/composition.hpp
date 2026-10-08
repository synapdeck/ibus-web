// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <vector>

#include "keys.hpp"
#include "session.hpp"
#include "sink.hpp"
#include "table.hpp"

namespace ibusweb::table {

// Whether a key's character would be typed: neither absent nor a control
// character. Keys such as Return carry control characters.
constexpr bool isPrintable(char32_t character) {
  return character >= 0x20 && character != 0x7f &&
         !(character >= 0x80 && character < 0xa0);
}

// Key releases and presses of modifier keys alone change nothing.
constexpr bool isInert(std::uint32_t keyval, std::uint32_t modifiers) {
  return (modifiers & masks::Release) != 0 || keys::isModifier(keyval);
}

// A session's candidates, its cursor and whether the cursor is shown.
class CandidateList {
public:
  void set(std::vector<Candidate> list, bool cursorShown);
  void clear();

  // The candidate under the cursor if it is shown.
  const Candidate *highlighted() const;
  const Candidate *at(std::size_t index) const;

  // Each returns whether anything changed. A hidden cursor is shown where it
  // is rather than moved.
  bool cursorUp();
  bool cursorDown();
  bool pageUp();
  bool pageDown();

  void show(Sink &sink) const;

  // Redraws only after a move that changed something.
  void showIfChanged(bool changed, Sink &sink) const;

private:
  std::vector<Candidate> list_;
  std::size_t cursor_ = 0;
  bool cursorShown_ = false;
};

std::unique_ptr<Session> makeCommandSession(const Table &table, Sink &sink);
std::unique_ptr<Session> makeContinuousSession(const Table &table, Sink &sink);

} // namespace ibusweb::table
