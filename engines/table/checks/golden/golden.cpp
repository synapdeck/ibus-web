// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

#include <cstdlib>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include <gtest/gtest.h>

#include "../../src/keys.hpp"
#include "../../src/session.hpp"
#include "../../src/table.hpp"
#include "../../src/utf8.hpp"
#include "recorder.hpp"

namespace ibusweb::table {
namespace {

using Events = std::vector<std::string>;
using Keys = std::vector<std::string>;

constexpr std::string_view commandTable = "name = Test\n"
                                          "languages = und\n"
                                          "mode = command\n"
                                          "trigger = \\\n"
                                          "---\n"
                                          "\\alpha\tα\n"
                                          "\\aleph\tℵ\n"
                                          "\\beta\tβ\n"
                                          "\\to\t→\n"
                                          "\\to\t⟶\n"
                                          "\\xa\t1\n"
                                          "\\xb\t2\n"
                                          "\\xc\t3\n"
                                          "\\xd\t4\n"
                                          "\\xe\t5\n"
                                          "\\xf\t6\n"
                                          "\\xg\t7\n"
                                          "\\xh\t8\n"
                                          "\\xi\t9\n"
                                          "\\xj\t10\n"
                                          "\\xk\t11\n"
                                          "\\xl\t12\n";

constexpr std::string_view continuousTable = "name = Mini\n"
                                             "languages = und\n"
                                             "mode = continuous\n"
                                             "---\n"
                                             "S\tʃ\n"
                                             "@\tə\n"
                                             "@\\\tɘ\n"
                                             "t`\tʈ\n"
                                             "_\t\u0361\n"
                                             "_0\t\u0325\n"
                                             "_h\tʰ\n"
                                             "_H\t\u0301\n"
                                             "_H_T\t\u1dc4\n";

// What ibus_keyval_to_unicode gives for the keys that have a character.
char32_t characterOf(std::uint32_t keyval) {
  switch (keyval) {
  case keys::BackSpace:
    return 0x08;
  case keys::Tab:
    return 0x09;
  case keys::Return:
  case keys::KP_Enter:
    return 0x0d;
  case keys::Escape:
    return 0x1b;
  case 0xffff:
    return 0x7f;
  case 0xff80:
    return 0x20;
  case 0xff89:
    return 0x09;
  default:
    if (keyval >= 0x20 && keyval < 0x7f) {
      return keyval;
    }
    if ((keyval & 0xff000000) == 0x01000000) {
      return keyval & 0x00ffffff;
    }
    return 0;
  }
}

Events commits(const Events &events) {
  Events result;
  for (const std::string &event : events) {
    if (event.starts_with("commit ")) {
      result.push_back(event);
    }
  }
  return result;
}

class SessionTest : public testing::Test {
protected:
  void load(std::string_view text) {
    auto parsed = Table::parse("test.table", text);
    ASSERT_TRUE(parsed) << parsed.error().message();
    table_.emplace(std::move(*parsed));
    session_ = makeSession(*table_, sink_);
  }

  bool press(std::uint32_t keyval, std::uint32_t modifiers = 0) {
    return session_->processKey(keyval, characterOf(keyval), modifiers);
  }

  // Types each character as its own key, and returns whether each was
  // consumed: `y` or `n`.
  std::string type(std::string_view text) {
    std::string consumed;
    for (std::size_t offset = 0; offset < text.size();) {
      const utf8::Decoded decoded = *utf8::decode(text, offset);
      const char32_t c = decoded.character;
      const std::uint32_t keyval = c < 0x7f ? c : 0x01000000 | c;
      consumed += session_->processKey(keyval, c, 0) ? 'y' : 'n';
      offset += decoded.length;
    }
    return consumed;
  }

  Recorder sink_;
  std::optional<Table> table_;
  std::unique_ptr<Session> session_;
};

class Command : public SessionTest {
protected:
  void SetUp() override { load(commandTable); }
};

class Continuous : public SessionTest {
protected:
  void SetUp() override { load(continuousTable); }
};

TEST(TableQueries, CompletionsByLengthThenCodePointThenFileOrder) {
  const auto table = Table::parse("test.table", commandTable);
  ASSERT_TRUE(table) << table.error().message();

  const auto all = table->completions("\\");
  ASSERT_EQ(all.size(), 17u);
  EXPECT_EQ(all[0].key, "\\to");
  EXPECT_EQ(all[0].output, "→");
  EXPECT_EQ(all[1].key, "\\to");
  EXPECT_EQ(all[1].output, "⟶");
  EXPECT_EQ(all[2].key, "\\xa");
  EXPECT_EQ(all[14].key, "\\beta");
  EXPECT_EQ(all[15].key, "\\aleph");
  EXPECT_EQ(all[16].key, "\\alpha");

  const auto al = table->completions("\\al");
  ASSERT_EQ(al.size(), 2u);
  EXPECT_EQ(al[0].key, "\\aleph");
  EXPECT_EQ(al[1].key, "\\alpha");

  EXPECT_TRUE(table->completions("\\q").empty());
}

TEST(TableQueries, ExactExtendableAndAlphabet) {
  const auto table = Table::parse("test.table", commandTable);
  ASSERT_TRUE(table) << table.error().message();

  const auto to = table->exact("\\to");
  ASSERT_EQ(to.size(), 2u);
  EXPECT_EQ(to[0], "→");
  EXPECT_EQ(to[1], "⟶");
  EXPECT_TRUE(table->exact("\\t").empty());

  EXPECT_TRUE(table->extendable("\\al"));
  EXPECT_TRUE(table->extendable("\\"));
  EXPECT_FALSE(table->extendable("\\alpha"));
  EXPECT_FALSE(table->extendable("\\q"));

  EXPECT_TRUE(table->inAlphabet(U'a'));
  EXPECT_FALSE(table->inAlphabet(U'\\'));
  EXPECT_FALSE(table->inAlphabet(U'2'));
}

TEST(TableQueries, LongestPrefix) {
  const auto table = Table::parse("test.table", continuousTable);
  ASSERT_TRUE(table) << table.error().message();

  const auto schwa = table->longestPrefix("@\\x");
  ASSERT_TRUE(schwa);
  EXPECT_EQ(schwa->first, 2u);
  EXPECT_EQ(schwa->second, "ɘ");

  const auto tone = table->longestPrefix("_H_0");
  ASSERT_TRUE(tone);
  EXPECT_EQ(tone->first, 2u);
  EXPECT_EQ(tone->second, "\u0301");

  EXPECT_FALSE(table->longestPrefix("t_"));
  EXPECT_TRUE(table->inAlphabet(U'\\'));
  EXPECT_FALSE(table->inAlphabet(U'x'));
}

// `\é` and `\to` are both three bytes long, and `\éa` and `\abc` four, so
// ordering by bytes rather than code points would interleave them.
TEST(TableQueries, CompletionsCountCodePoints) {
  const auto table = Table::parse("test.table", "name = Accents\n"
                                                "languages = und\n"
                                                "mode = command\n"
                                                "trigger = \\\n"
                                                "---\n"
                                                "\\abc\t1\n"
                                                "\\éa\t2\n"
                                                "\\to\t3\n"
                                                "\\é\t4\n"
                                                "\\ab\t5\n");
  ASSERT_TRUE(table) << table.error().message();

  Keys keys;
  for (const Candidate &candidate : table->completions("\\")) {
    keys.push_back(candidate.key);
  }
  EXPECT_EQ(keys, (Keys{"\\é", "\\ab", "\\to", "\\éa", "\\abc"}));
  EXPECT_TRUE(table->inAlphabet(U'é'));
}

TEST(TableQueries, ShippedLatexSpace) {
  const char *path = std::getenv("IBUS_WEB_LATEX_TABLE");
  ASSERT_NE(path, nullptr) << "IBUS_WEB_LATEX_TABLE is required";
  const auto table = Table::load(path);
  ASSERT_TRUE(table) << table.error().message();

  const auto space = table->exact("\\space");
  ASSERT_EQ(space.size(), 1u);
  EXPECT_EQ(space[0], " ");
}

TEST_F(Command, IdleKeysPassThrough) {
  EXPECT_EQ(type("a,"), "nn");
  EXPECT_EQ(press(keys::Return), false);
  EXPECT_EQ(press(keys::BackSpace), false);
  EXPECT_EQ(sink_.take(), Events{});
}

TEST_F(Command, TriggerOpensComposition) {
  EXPECT_EQ(type("\\"), "y");
  EXPECT_EQ(sink_.take(),
            (Events{"preedit \"\\\"", "candidates 17 cursor 0 hidden"}));
}

TEST_F(Command, CompletionsWithoutExactMatchHideTheCursor) {
  EXPECT_EQ(type("\\al"), "yyy");
  EXPECT_EQ(sink_.take().back(), "candidates 2 cursor 0 hidden");
  EXPECT_EQ(sink_.keys(), (Keys{"\\aleph", "\\alpha"}));
}

TEST_F(Command, ExactMatchShowsTheCursor) {
  EXPECT_EQ(type("\\alpha"), "yyyyyy");
  EXPECT_EQ(sink_.take().back(), "candidates 1 cursor 0 shown");
}

TEST_F(Command, SpaceCommitsTheHighlightedCandidate) {
  type("\\alpha");
  sink_.take();
  EXPECT_TRUE(press(keys::space));
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"α\"", "preedit \"\"", "candidates none"}));
}

TEST_F(Command, SpaceWithoutCursorCommitsTheBufferAndIsTyped) {
  type("\\al");
  sink_.take();
  EXPECT_FALSE(press(keys::space));
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"\\al\"", "preedit \"\"", "candidates none"}));
}

TEST_F(Command, DeadEndStaysAsTyped) {
  EXPECT_EQ(type("\\alphabet"), "yyyyyyyyy");
  EXPECT_EQ(sink_.take().back(), "candidates none");
  EXPECT_TRUE(press(keys::Return));
  EXPECT_EQ(sink_.take(), (Events{"commit \"\\alphabet\"", "preedit \"\"",
                                  "candidates none"}));
}

TEST_F(Command, PunctuationCommitsThenIsTyped) {
  EXPECT_EQ(type("\\alpha,"), "yyyyyyn");
  EXPECT_EQ(sink_.take().back(), "candidates none");
}

TEST_F(Command, PunctuationCommitsTheHighlightedCandidate) {
  type("\\alpha");
  sink_.take();
  EXPECT_EQ(type(","), "n");
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"α\"", "preedit \"\"", "candidates none"}));
}

TEST_F(Command, DigitIsNotInTheAlphabet) {
  type("\\al");
  sink_.take();
  EXPECT_EQ(type("2"), "n");
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"\\al\"", "preedit \"\"", "candidates none"}));
}

TEST_F(Command, TriggerCommitsAndOpensAnother) {
  type("\\alpha");
  sink_.take();
  EXPECT_EQ(type("\\"), "y");
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"α\"", "preedit \"\"", "candidates none",
                    "preedit \"\\\"", "candidates 17 cursor 0 hidden"}));
  EXPECT_EQ(type("beta"), "yyyy");
  EXPECT_EQ(sink_.take().back(), "candidates 1 cursor 0 shown");
  EXPECT_TRUE(press(keys::Return));
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"β\"", "preedit \"\"", "candidates none"}));
}

TEST_F(Command, EnterCommitsTheBufferWithoutCursor) {
  type("\\al");
  sink_.take();
  EXPECT_TRUE(press(keys::KP_Enter));
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"\\al\"", "preedit \"\"", "candidates none"}));
}

TEST_F(Command, EnterCommitsTheHighlightedCandidate) {
  type("\\to");
  press(keys::Down);
  sink_.take();
  EXPECT_TRUE(press(keys::Return));
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"⟶\"", "preedit \"\"", "candidates none"}));
}

TEST_F(Command, ArrowsAndTabMoveTheCursor) {
  type("\\to");
  sink_.take();
  EXPECT_TRUE(press(keys::Down));
  EXPECT_EQ(sink_.take(), (Events{"candidates 2 cursor 1 shown"}));
  EXPECT_TRUE(press(keys::Down));
  EXPECT_EQ(sink_.take(), Events{});
  EXPECT_TRUE(press(keys::Up));
  EXPECT_EQ(sink_.take(), (Events{"candidates 2 cursor 0 shown"}));
  EXPECT_TRUE(press(keys::Tab));
  EXPECT_EQ(sink_.take(), (Events{"candidates 2 cursor 1 shown"}));
  EXPECT_TRUE(press(keys::ISO_Left_Tab, masks::Shift));
  EXPECT_EQ(sink_.take(), (Events{"candidates 2 cursor 0 shown"}));
  EXPECT_TRUE(press(keys::Tab));
  EXPECT_TRUE(press(keys::Tab, masks::Shift));
  EXPECT_EQ(sink_.take(), (Events{"candidates 2 cursor 1 shown",
                                  "candidates 2 cursor 0 shown"}));
}

TEST_F(Command, MovingAHiddenCursorShowsItInPlace) {
  type("\\al");
  sink_.take();
  EXPECT_TRUE(press(keys::Down));
  EXPECT_EQ(sink_.take(), (Events{"candidates 2 cursor 0 shown"}));
  EXPECT_TRUE(press(keys::space));
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"ℵ\"", "preedit \"\"", "candidates none"}));
}

TEST_F(Command, Paging) {
  type("\\x");
  EXPECT_EQ(sink_.take().back(), "candidates 12 cursor 0 hidden");
  EXPECT_TRUE(press(keys::Page_Down));
  EXPECT_EQ(sink_.take(), (Events{"candidates 12 cursor 10 hidden"}));
  EXPECT_TRUE(press(keys::Page_Down));
  EXPECT_EQ(sink_.take(), Events{});
  EXPECT_TRUE(press(keys::Page_Up));
  EXPECT_EQ(sink_.take(), (Events{"candidates 12 cursor 0 hidden"}));
  EXPECT_TRUE(press(keys::Page_Up));
  EXPECT_EQ(sink_.take(), Events{});

  press(keys::Down);
  press(keys::Down);
  sink_.take();
  session_->pageDown();
  EXPECT_EQ(sink_.take(), (Events{"candidates 12 cursor 11 shown"}));
  session_->pageUp();
  EXPECT_EQ(sink_.take(), (Events{"candidates 12 cursor 1 shown"}));
  EXPECT_TRUE(press(keys::space));
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"2\"", "preedit \"\"", "candidates none"}));
}

TEST_F(Command, BackspaceThroughTheTrigger) {
  type("\\a");
  sink_.take();
  EXPECT_TRUE(press(keys::BackSpace));
  EXPECT_EQ(sink_.take(),
            (Events{"preedit \"\\\"", "candidates 17 cursor 0 hidden"}));
  EXPECT_TRUE(press(keys::BackSpace));
  EXPECT_EQ(sink_.take(), (Events{"preedit \"\"", "candidates none"}));
  EXPECT_FALSE(press(keys::BackSpace));
  EXPECT_EQ(sink_.take(), Events{});
}

TEST_F(Command, EscapeCommitsTheBuffer) {
  type("\\alpha");
  sink_.take();
  EXPECT_TRUE(press(keys::Escape));
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"\\alpha\"", "preedit \"\"", "candidates none"}));
}

TEST_F(Command, CaretKeysCommitTheBufferAndPassThrough) {
  for (const std::uint32_t keyval :
       {keys::Left, keys::Right, keys::Home, keys::End}) {
    type("\\al");
    sink_.take();
    EXPECT_FALSE(press(keyval));
    EXPECT_EQ(sink_.take(),
              (Events{"commit \"\\al\"", "preedit \"\"", "candidates none"}));
  }
}

TEST_F(Command, ModifiersCommitTheBufferAndPassThrough) {
  for (const std::uint32_t mask : {masks::Control, masks::Mod1, masks::Super}) {
    type("\\alpha");
    sink_.take();
    EXPECT_FALSE(press('c', mask));
    EXPECT_EQ(sink_.take(), (Events{"commit \"\\alpha\"", "preedit \"\"",
                                    "candidates none"}));
  }
  EXPECT_FALSE(press('\\', masks::Control));
  EXPECT_EQ(sink_.take(), Events{});
}

TEST_F(Command, ReleasesAndModifierKeysChangeNothing) {
  type("\\al");
  sink_.take();
  EXPECT_FALSE(press('p', masks::Release));
  EXPECT_FALSE(press(0xffe1));
  EXPECT_FALSE(press(0xffe3, masks::Shift));
  for (const std::uint32_t level5 : {0xfe11u, 0xfe12u, 0xfe13u}) {
    EXPECT_FALSE(press(level5));
  }
  EXPECT_EQ(sink_.take(), Events{});
}

TEST_F(Command, KeypadKeysActLikeTheirMainKeys) {
  type("\\to");
  sink_.take();
  EXPECT_TRUE(press(0xff99));
  EXPECT_TRUE(press(0xff97));
  EXPECT_TRUE(press(0xff89));
  EXPECT_EQ(sink_.take(), (Events{"candidates 2 cursor 1 shown",
                                  "candidates 2 cursor 0 shown",
                                  "candidates 2 cursor 1 shown"}));
  EXPECT_TRUE(press(0xff80));
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"⟶\"", "preedit \"\"", "candidates none"}));

  type("\\al");
  sink_.take();
  EXPECT_FALSE(press(0xff80));
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"\\al\"", "preedit \"\"", "candidates none"}));
}

TEST_F(Command, KeysThatTypeNothingCommitTheBufferAndPassThrough) {
  for (const std::uint32_t keyval : {0xffffu, 0xff63u, 0xffbeu}) {
    type("\\al");
    sink_.take();
    EXPECT_FALSE(press(keyval));
    EXPECT_EQ(sink_.take(),
              (Events{"commit \"\\al\"", "preedit \"\"", "candidates none"}));
  }
}

TEST_F(Command, ClickingACandidateCommitsIt) {
  type("\\x");
  sink_.take();
  session_->candidateClicked(12);
  EXPECT_EQ(sink_.take(), Events{});
  session_->candidateClicked(11);
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"12\"", "preedit \"\"", "candidates none"}));
}

TEST_F(Command, ResetEmitsNothing) {
  type("\\al");
  sink_.take();
  session_->reset();
  EXPECT_EQ(sink_.take(), Events{});
  EXPECT_EQ(type("a"), "n");
  EXPECT_EQ(sink_.take(), Events{});
}

TEST_F(Continuous, UnextendableKeyCommitsAtOnce) {
  EXPECT_EQ(type("S"), "y");
  EXPECT_EQ(sink_.take(), (Events{"commit \"ʃ\""}));
}

TEST_F(Continuous, LongestMatch) {
  EXPECT_EQ(type("@"), "y");
  EXPECT_EQ(sink_.take(),
            (Events{"preedit \"@\"", "candidates 2 cursor 0 hidden"}));
  EXPECT_EQ(type("\\"), "y");
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"ɘ\"", "preedit \"\"", "candidates none"}));
}

TEST_F(Continuous, LiteralFallback) {
  EXPECT_EQ(type("t_"), "yy");
  EXPECT_EQ(
      sink_.take(),
      (Events{"preedit \"t\"", "candidates 1 cursor 0 hidden", "commit \"t\"",
              "preedit \"_\"", "candidates 5 cursor 0 hidden"}));
  EXPECT_EQ(type("h"), "y");
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"ʰ\"", "preedit \"\"", "candidates none"}));
}

TEST_F(Continuous, CombiningMarksCommitAsWritten) {
  type("@_");
  sink_.take();
  EXPECT_EQ(type("0"), "y");
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"\u0325\"", "preedit \"\"", "candidates none"}));

  EXPECT_EQ(type("_H_0"), "yyyy");
  EXPECT_EQ(commits(sink_.take()), (Events{"commit \"\u0301\u0325\""}));

  type("_H_T");
  EXPECT_EQ(commits(sink_.take()), (Events{"commit \"\u1dc4\""}));
}

TEST(ContinuousPaging, PagesTheCandidateGuide) {
  Recorder sink;
  auto table = Table::parse("test.table", "name = Wide\n"
                                          "languages = und\n"
                                          "mode = continuous\n"
                                          "---\n"
                                          "xa\t1\nxb\t2\nxc\t3\nxd\t4\n"
                                          "xe\t5\nxf\t6\nxg\t7\nxh\t8\n"
                                          "xi\t9\nxj\t10\nxk\t11\nxl\t12\n");
  ASSERT_TRUE(table) << table.error().message();
  const auto session = makeSession(*table, sink);

  session->processKey('x', 'x', 0);
  EXPECT_EQ(sink.take().back(), "candidates 12 cursor 0 hidden");
  session->pageDown();
  EXPECT_EQ(sink.take(), (Events{"candidates 12 cursor 10 hidden"}));
  session->pageDown();
  EXPECT_EQ(sink.take(), Events{});
  session->pageUp();
  EXPECT_EQ(sink.take(), (Events{"candidates 12 cursor 0 hidden"}));
  session->pageUp();
  EXPECT_EQ(sink.take(), Events{});

  session->pageDown();
  sink.take();
  session->candidateClicked(11);
  EXPECT_EQ(sink.take(),
            (Events{"commit \"12\"", "preedit \"\"", "candidates none"}));
}

TEST_F(Continuous, SpaceFlushesAndPassesThrough) {
  type("@");
  sink_.take();
  EXPECT_FALSE(press(keys::space));
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"ə\"", "preedit \"\"", "candidates none"}));
}

TEST_F(Continuous, EnterFlushesAndPassesThrough) {
  type("_H");
  sink_.take();
  EXPECT_FALSE(press(keys::Return));
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"\u0301\"", "preedit \"\"", "candidates none"}));
}

TEST_F(Continuous, FlushUsesLiteralFallback) {
  type("t");
  sink_.take();
  EXPECT_FALSE(press(keys::Escape));
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"t\"", "preedit \"\"", "candidates none"}));
}

TEST_F(Continuous, CharactersOutsideTheAlphabetFlush) {
  type("@");
  sink_.take();
  EXPECT_EQ(type("x"), "n");
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"ə\"", "preedit \"\"", "candidates none"}));
  EXPECT_EQ(type("x"), "n");
  EXPECT_EQ(sink_.take(), Events{});
}

TEST_F(Continuous, BackspaceDeletesPendingCharacters) {
  type("_H");
  sink_.take();
  EXPECT_TRUE(press(keys::BackSpace));
  EXPECT_EQ(sink_.take(),
            (Events{"preedit \"_\"", "candidates 5 cursor 0 hidden"}));
  EXPECT_TRUE(press(keys::BackSpace));
  EXPECT_EQ(sink_.take(), (Events{"preedit \"\"", "candidates none"}));
  EXPECT_FALSE(press(keys::BackSpace));
  EXPECT_EQ(sink_.take(), Events{});
}

TEST_F(Continuous, ModifiersFlushAndPassThrough) {
  type("@");
  sink_.take();
  EXPECT_FALSE(press('a', masks::Control));
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"ə\"", "preedit \"\"", "candidates none"}));
  EXPECT_FALSE(press('S', masks::Mod1));
  EXPECT_EQ(sink_.take(), Events{});
}

TEST_F(Continuous, ModifierKeysAndReleasesChangeNothing) {
  type("_");
  sink_.take();
  EXPECT_FALSE(press(0xffe1));
  EXPECT_FALSE(press('_', masks::Shift | masks::Release));
  for (const std::uint32_t level5 : {0xfe11u, 0xfe12u, 0xfe13u}) {
    EXPECT_FALSE(press(level5));
  }
  EXPECT_EQ(sink_.take(), Events{});
  EXPECT_TRUE(press('H', masks::Shift));
  EXPECT_EQ(sink_.take(),
            (Events{"preedit \"_H\"", "candidates 2 cursor 0 hidden"}));
}

TEST_F(Continuous, KeypadKeysFlushLikeTheirMainKeys) {
  for (const std::uint32_t keyval : {0xff80u, 0xff89u, 0xff97u, 0xff99u}) {
    type("_");
    sink_.take();
    EXPECT_FALSE(press(keyval));
    EXPECT_EQ(sink_.take(),
              (Events{"commit \"\u0361\"", "preedit \"\"", "candidates none"}));
  }
}

TEST_F(Continuous, CandidatesGuideAndCanBeClicked) {
  type("_");
  sink_.take();
  EXPECT_EQ(sink_.keys(), (Keys{"_", "_0", "_H", "_h", "_H_T"}));

  session_->cursorDown();
  session_->cursorUp();
  EXPECT_EQ(sink_.take(), Events{});

  session_->candidateClicked(2);
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"\u0301\"", "preedit \"\"", "candidates none"}));
}

TEST_F(Continuous, ArrowsFlushRatherThanNavigate) {
  type("_");
  sink_.take();
  EXPECT_FALSE(press(keys::Down));
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"\u0361\"", "preedit \"\"", "candidates none"}));
}

TEST_F(Continuous, ResetEmitsNothing) {
  type("_H");
  sink_.take();
  session_->reset();
  EXPECT_EQ(sink_.take(), Events{});
  EXPECT_FALSE(press(keys::space));
  EXPECT_EQ(sink_.take(), Events{});
}

TEST(Xsampa, ShippedTable) {
  const char *path = std::getenv("IBUS_WEB_XSAMPA_TABLE");
  ASSERT_NE(path, nullptr) << "IBUS_WEB_XSAMPA_TABLE is required";
  const auto table = Table::load(path);
  ASSERT_TRUE(table) << table.error().message();

  Recorder sink;
  const auto session = makeSession(*table, sink);
  const auto type = [&](std::string_view text) {
    for (const char c : text) {
      session->processKey(static_cast<unsigned char>(c), c, 0);
    }
  };

  type("S@");
  EXPECT_FALSE(session->processKey(keys::space, U' ', 0));
  type("t_hr\\`");
  EXPECT_FALSE(session->processKey(keys::space, U' ', 0));

  std::string committed;
  for (const std::string &event : sink.take()) {
    if (event.starts_with("commit ")) {
      committed += event.substr(8, event.size() - 9);
    }
  }
  EXPECT_EQ(committed, "ʃətʰɻ");
}

} // namespace
} // namespace ibusweb::table
