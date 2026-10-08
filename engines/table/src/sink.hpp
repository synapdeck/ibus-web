// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

#pragma once

#include <cstddef>
#include <span>
#include <string_view>

#include "table.hpp"

namespace ibusweb::table {

// What a session writes to. Within one call into a session, a commit comes
// before the preedit and the candidates that follow it.
class Sink {
public:
  virtual ~Sink() = default;

  virtual void commit(std::string_view text) = 0;

  // Empty hides the preedit.
  virtual void preedit(std::string_view text) = 0;

  // The whole list, paged by the cursor; empty hides it.
  virtual void candidates(std::span<const Candidate> all, std::size_t cursor,
                          bool cursorShown) = 0;
};

} // namespace ibusweb::table
