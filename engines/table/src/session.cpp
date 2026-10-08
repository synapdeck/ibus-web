// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

#include "session.hpp"

#include <algorithm>
#include <utility>

#include "composition.hpp"

namespace ibusweb::table {

void CandidateList::set(std::vector<Candidate> list, bool cursorShown) {
  list_ = std::move(list);
  cursor_ = 0;
  cursorShown_ = cursorShown && !list_.empty();
}

void CandidateList::clear() { set({}, false); }

const Candidate *CandidateList::highlighted() const {
  return cursorShown_ ? &list_[cursor_] : nullptr;
}

const Candidate *CandidateList::at(std::size_t index) const {
  return index < list_.size() ? &list_[index] : nullptr;
}

bool CandidateList::cursorUp() {
  if (list_.empty()) {
    return false;
  }
  if (!cursorShown_) {
    cursorShown_ = true;
    return true;
  }
  if (cursor_ == 0) {
    return false;
  }
  --cursor_;
  return true;
}

bool CandidateList::cursorDown() {
  if (list_.empty()) {
    return false;
  }
  if (!cursorShown_) {
    cursorShown_ = true;
    return true;
  }
  if (cursor_ + 1 == list_.size()) {
    return false;
  }
  ++cursor_;
  return true;
}

bool CandidateList::pageUp() {
  if (cursor_ < pageSize) {
    return false;
  }
  cursor_ -= pageSize;
  return true;
}

bool CandidateList::pageDown() {
  const std::size_t nextPage = (cursor_ / pageSize + 1) * pageSize;
  if (nextPage >= list_.size()) {
    return false;
  }
  cursor_ = std::min(cursor_ + pageSize, list_.size() - 1);
  return true;
}

void CandidateList::show(Sink &sink) const {
  sink.candidates(list_, cursor_, cursorShown_);
}

void CandidateList::showIfChanged(bool changed, Sink &sink) const {
  if (changed) {
    show(sink);
  }
}

std::unique_ptr<Session> makeSession(const Table &table, Sink &sink) {
  if (table.frontmatter().mode == Mode::command) {
    return makeCommandSession(table, sink);
  }
  return makeContinuousSession(table, sink);
}

} // namespace ibusweb::table
