// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
#define G_LOG_DOMAIN "ibus-web-table"

#include "session.hpp"
#include "sink.hpp"
#include "table.hpp"

#include <algorithm>
#include <cstddef>
#include <exception>
#include <expected>
#include <filesystem>
#include <functional>
#include <ibus-web/runtime.h>
#include <ibus.h>
#include <map>
#include <memory>
#include <span>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>
#include <vector>

namespace {

using ibusweb::table::Candidate;
using ibusweb::table::makeSession;
using ibusweb::table::pageSize;
using ibusweb::table::Session;
using ibusweb::table::Sink;
using ibusweb::table::Table;

// A store path, compiled in so that the tables stay in the side module's
// data closure. Each engine is named for its table's file.
constexpr char tableDir[] = IBUSWEB_TABLE_DIR;

// Parsed on first use and kept for the module's lifetime, which is the
// Worker's: sessions hold their table by reference.
std::map<std::string, Table, std::less<>> tables;

// The engine's table, parsed on first use, or the parser's path:line: reason
// if it doesn't parse.
std::expected<const Table *, std::string> loadTable(std::string_view name) {
  if (auto found = tables.find(name); found != tables.end())
    return &found->second;

  auto table = Table::load(std::filesystem::path(tableDir) /
                           (std::string(name) + ".table"));
  if (!table)
    return std::unexpected(table.error().message());
  return &tables.emplace(std::string(name), *std::move(table)).first->second;
}

// An engine instance's C++ half: its session, and the Sink the session
// writes to, which turns what it writes into the engine's output.
class Context final : public Sink {
public:
  explicit Context(IBusEngine *engine) : engine_(engine) {}

  void start(const Table &table) { session_ = makeSession(table, *this); }

  Session *session() const { return session_.get(); }

  // The panel counts a click's index from the visible page's first
  // candidate. A position no candidate holds is ignored.
  void clicked(guint index) {
    if (session_ && index < pageLength_)
      session_->candidateClicked(pageStart_ + index);
  }

  void reset() {
    if (session_)
      session_->reset();
    pageStart_ = pageLength_ = 0;
  }

  void commit(std::string_view text) override {
    ibus_engine_commit_text(
        engine_, ibus_text_new_from_string(std::string(text).c_str()));
  }

  void preedit(std::string_view text) override {
    if (text.empty()) {
      ibus_engine_update_preedit_text_with_mode(
          engine_, ibus_text_new_from_static_string(""), 0, FALSE,
          IBUS_ENGINE_PREEDIT_COMMIT);
      return;
    }

    IBusText *shown = ibus_text_new_from_string(std::string(text).c_str());
    const guint length = ibus_text_get_length(shown);
    ibus_text_append_attribute(shown, IBUS_ATTR_TYPE_UNDERLINE,
                               IBUS_ATTR_UNDERLINE_SINGLE, 0,
                               static_cast<gint>(length));
    ibus_engine_update_preedit_text_with_mode(engine_, shown, length, TRUE,
                                              IBUS_ENGINE_PREEDIT_COMMIT);
  }

  // IBus gets only the page holding the cursor, with the cursor's place on
  // it: a bare trigger completes to every command in the table, thousands of
  // candidates. The panel draws what it is sent as one page and hands paging
  // and cursor moves back to the engine, which passes them to the session.
  void candidates(std::span<const Candidate> all, std::size_t cursor,
                  bool cursorShown) override {
    if (all.empty()) {
      pageStart_ = pageLength_ = 0;
      ibus_engine_hide_lookup_table(engine_);
      return;
    }

    pageStart_ = cursor / pageSize * pageSize;
    pageLength_ = std::min(pageSize, all.size() - pageStart_);
    IBusLookupTable *table =
        ibus_lookup_table_new(pageSize, 0, cursorShown, FALSE);
    for (const Candidate &candidate : all.subspan(pageStart_, pageLength_)) {
      const std::string text = candidate.output + " " + candidate.key;
      ibus_lookup_table_append_candidate(
          table, ibus_text_new_from_string(text.c_str()));
    }
    ibus_lookup_table_set_cursor_pos(table, cursor - pageStart_);
    ibus_engine_update_lookup_table(engine_, table, TRUE);
  }

private:
  IBusEngine *engine_;
  std::unique_ptr<Session> session_;
  std::size_t pageStart_ = 0;
  std::size_t pageLength_ = 0;
};

// GObject allocates instances as zeroed C memory, so the C++ half lives
// behind a pointer: made in instance init, deleted in finalize.
struct Engine {
  IBusEngine parent;
  Context *context;
};

struct EngineClass {
  IBusEngineClass parent;
};

GObjectClass *parentClass;

Engine *engineOf(gpointer instance) { return static_cast<Engine *>(instance); }

Session *sessionOf(IBusEngine *engine) {
  return engineOf(engine)->context->session();
}

gboolean processKeyEvent(IBusEngine *engine, guint keyval, guint, guint state) {
  Session *session = sessionOf(engine);
  return session != nullptr &&
         session->processKey(keyval, ibus_keyval_to_unicode(keyval), state);
}

void resetEngine(IBusEngine *engine) { engineOf(engine)->context->reset(); }

void pageUp(IBusEngine *engine) {
  if (Session *session = sessionOf(engine))
    session->pageUp();
}

void pageDown(IBusEngine *engine) {
  if (Session *session = sessionOf(engine))
    session->pageDown();
}

void cursorUp(IBusEngine *engine) {
  if (Session *session = sessionOf(engine))
    session->cursorUp();
}

void cursorDown(IBusEngine *engine) {
  if (Session *session = sessionOf(engine))
    session->cursorDown();
}

void candidateClicked(IBusEngine *engine, guint index, guint, guint) {
  engineOf(engine)->context->clicked(index);
}

// engine-name, which picks the table, is a construct property, so it is
// first readable here. The factory's handler has loaded the table by now.
void constructed(GObject *object) {
  parentClass->constructed(object);

  Engine *self = engineOf(object);
  if (auto found = tables.find(ibus_engine_get_name(&self->parent));
      found != tables.end())
    self->context->start(found->second);
}

void finalize(GObject *object) {
  delete engineOf(object)->context;
  parentClass->finalize(object);
}

void classInit(gpointer klass, gpointer) {
  parentClass = static_cast<GObjectClass *>(g_type_class_peek_parent(klass));

  auto *object = static_cast<GObjectClass *>(klass);
  object->constructed = constructed;
  object->finalize = finalize;

  auto *engine = static_cast<IBusEngineClass *>(klass);
  engine->process_key_event = processKeyEvent;
  engine->focus_out = resetEngine;
  engine->reset = resetEngine;
  engine->page_up = pageUp;
  engine->page_down = pageDown;
  engine->cursor_up = cursorUp;
  engine->cursor_down = cursorDown;
  engine->candidate_clicked = candidateClicked;
}

void instanceInit(GTypeInstance *instance, gpointer) {
  Engine *self = engineOf(instance);
  self->context = new Context(&self->parent);
}

GType engineType() {
  static const GType type = g_type_register_static_simple(
      IBUS_TYPE_ENGINE, g_intern_static_string("IBusWebTableEngine"),
      sizeof(EngineClass), classInit, sizeof(Engine), instanceInit,
      static_cast<GTypeFlags>(0));
  return type;
}

// Runs before the factory's own handler, which makes the engine. A table that
// doesn't parse fails CreateEngine with the parser's message, which also
// stops the emission, so no engine is made. An exception unwinding through
// GLib's emission would leave the runtime faulted, so none leaves here.
IBusEngine *createEngine(IBusFactory *, const gchar *name, gpointer) {
  std::string failure;
  try {
    if (auto table = loadTable(name); !table)
      failure = std::move(table.error());
  } catch (const std::exception &error) {
    failure = std::string(name) + ": " + error.what();
  }

  if (!failure.empty())
    ibusweb_factory_fail_create(failure.c_str());
  return nullptr;
}

std::vector<std::string> engineNames() {
  std::vector<std::string> names;
  std::error_code error;
  for (std::filesystem::directory_iterator entry(tableDir, error), end;
       !error && entry != end; entry.increment(error))
    if (entry->path().extension() == ".table")
      names.push_back(entry->path().stem().string());

  if (error)
    g_warning("%s: %s", tableDir, error.message().c_str());
  return names;
}

} // namespace

// Keeps the compiled panel schema, which the module's settings metadata
// lists, in the side module's data closure.
extern "C" const char ibusweb_table_settings_schema_dir[] =
    IBUSWEB_SETTINGS_SCHEMA_DIR;

void ibusweb_module_init(IBusWebModule *) {
  IBusFactory *factory = ibus_factory_new(nullptr);
  g_object_ref_sink(factory);
  g_signal_connect(factory, "create-engine", G_CALLBACK(createEngine), nullptr);
  for (const std::string &name : engineNames())
    ibus_factory_add_engine(factory, name.c_str(), engineType());
  g_object_unref(factory);
}
