// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>

#include "sink.hpp"
#include "table.hpp"

namespace ibusweb::table {

inline constexpr std::size_t pageSize = 10;

// One input context's composition. The table and the sink must outlive it.
class Session {
public:
  virtual ~Session() = default;

  // `character` is the key's Unicode value, or 0 if it has none. Returns
  // whether the key was consumed.
  virtual bool processKey(std::uint32_t keyval, char32_t character,
                          std::uint32_t modifiers) = 0;

  // An absolute index into the candidate list.
  virtual void candidateClicked(std::size_t index) = 0;

  virtual void pageUp() = 0;
  virtual void pageDown() = 0;
  virtual void cursorUp() = 0;
  virtual void cursorDown() = 0;

  // Clears the state and emits nothing: the page commits a visible preedit
  // itself.
  virtual void reset() = 0;
};

// A session of the table's mode.
std::unique_ptr<Session> makeSession(const Table &table, Sink &sink);

} // namespace ibusweb::table
