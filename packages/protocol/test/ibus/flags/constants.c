/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

#define IBUS_COMPILATION
#include <glib.h>
#include <ibustypes.h>
#include <stdio.h>

int main(void) {
  printf("{\"IBusCapability\": {");
  printf("\"PREEDIT_TEXT\": %u", (unsigned)IBUS_CAP_PREEDIT_TEXT);
  printf(", \"AUXILIARY_TEXT\": %u", (unsigned)IBUS_CAP_AUXILIARY_TEXT);
  printf(", \"LOOKUP_TABLE\": %u", (unsigned)IBUS_CAP_LOOKUP_TABLE);
  printf(", \"FOCUS\": %u", (unsigned)IBUS_CAP_FOCUS);
  printf(", \"PROPERTY\": %u", (unsigned)IBUS_CAP_PROPERTY);
  printf(", \"SURROUNDING_TEXT\": %u", (unsigned)IBUS_CAP_SURROUNDING_TEXT);
  printf(", \"OSK\": %u", (unsigned)IBUS_CAP_OSK);
  printf(", \"SYNC_PROCESS_KEY\": %u", (unsigned)IBUS_CAP_SYNC_PROCESS_KEY);
  printf(", \"SYNC_PROCESS_KEY_V2\": %u",
         (unsigned)IBUS_CAP_SYNC_PROCESS_KEY_V2);
  printf("}");
  printf(", \"IBusModifier\": {");
  printf("\"SHIFT\": %u", (unsigned)IBUS_SHIFT_MASK);
  printf(", \"LOCK\": %u", (unsigned)IBUS_LOCK_MASK);
  printf(", \"CONTROL\": %u", (unsigned)IBUS_CONTROL_MASK);
  printf(", \"MOD1\": %u", (unsigned)IBUS_MOD1_MASK);
  printf(", \"MOD2\": %u", (unsigned)IBUS_MOD2_MASK);
  printf(", \"MOD3\": %u", (unsigned)IBUS_MOD3_MASK);
  printf(", \"MOD4\": %u", (unsigned)IBUS_MOD4_MASK);
  printf(", \"MOD5\": %u", (unsigned)IBUS_MOD5_MASK);
  printf(", \"BUTTON1\": %u", (unsigned)IBUS_BUTTON1_MASK);
  printf(", \"BUTTON2\": %u", (unsigned)IBUS_BUTTON2_MASK);
  printf(", \"BUTTON3\": %u", (unsigned)IBUS_BUTTON3_MASK);
  printf(", \"BUTTON4\": %u", (unsigned)IBUS_BUTTON4_MASK);
  printf(", \"BUTTON5\": %u", (unsigned)IBUS_BUTTON5_MASK);
  printf(", \"HANDLED\": %u", (unsigned)IBUS_HANDLED_MASK);
  printf(", \"FORWARD\": %u", (unsigned)IBUS_FORWARD_MASK);
  printf(", \"IGNORED\": %u", (unsigned)IBUS_IGNORED_MASK);
  printf(", \"SUPER\": %u", (unsigned)IBUS_SUPER_MASK);
  printf(", \"HYPER\": %u", (unsigned)IBUS_HYPER_MASK);
  printf(", \"META\": %u", (unsigned)IBUS_META_MASK);
  printf(", \"RELEASE\": %u", (unsigned)IBUS_RELEASE_MASK);
  printf(", \"MODIFIER\": %u", (unsigned)IBUS_MODIFIER_MASK);
  printf("}");
  printf(", \"IBusInputPurpose\": {");
  printf("\"FREE_FORM\": %u", (unsigned)IBUS_INPUT_PURPOSE_FREE_FORM);
  printf(", \"ALPHA\": %u", (unsigned)IBUS_INPUT_PURPOSE_ALPHA);
  printf(", \"DIGITS\": %u", (unsigned)IBUS_INPUT_PURPOSE_DIGITS);
  printf(", \"NUMBER\": %u", (unsigned)IBUS_INPUT_PURPOSE_NUMBER);
  printf(", \"PHONE\": %u", (unsigned)IBUS_INPUT_PURPOSE_PHONE);
  printf(", \"URL\": %u", (unsigned)IBUS_INPUT_PURPOSE_URL);
  printf(", \"EMAIL\": %u", (unsigned)IBUS_INPUT_PURPOSE_EMAIL);
  printf(", \"NAME\": %u", (unsigned)IBUS_INPUT_PURPOSE_NAME);
  printf(", \"PASSWORD\": %u", (unsigned)IBUS_INPUT_PURPOSE_PASSWORD);
  printf(", \"PIN\": %u", (unsigned)IBUS_INPUT_PURPOSE_PIN);
  printf(", \"TERMINAL\": %u", (unsigned)IBUS_INPUT_PURPOSE_TERMINAL);
  printf(", \"DATE\": %u", (unsigned)IBUS_INPUT_PURPOSE_DATE);
  printf(", \"TIME\": %u", (unsigned)IBUS_INPUT_PURPOSE_TIME);
  printf(", \"DATETIME\": %u", (unsigned)IBUS_INPUT_PURPOSE_DATETIME);
  printf("}");
  printf(", \"IBusInputHints\": {");
  printf("\"NONE\": %u", (unsigned)IBUS_INPUT_HINT_NONE);
  printf(", \"SPELLCHECK\": %u", (unsigned)IBUS_INPUT_HINT_SPELLCHECK);
  printf(", \"NO_SPELLCHECK\": %u", (unsigned)IBUS_INPUT_HINT_NO_SPELLCHECK);
  printf(", \"WORD_COMPLETION\": %u",
         (unsigned)IBUS_INPUT_HINT_WORD_COMPLETION);
  printf(", \"LOWERCASE\": %u", (unsigned)IBUS_INPUT_HINT_LOWERCASE);
  printf(", \"UPPERCASE_CHARS\": %u",
         (unsigned)IBUS_INPUT_HINT_UPPERCASE_CHARS);
  printf(", \"UPPERCASE_WORDS\": %u",
         (unsigned)IBUS_INPUT_HINT_UPPERCASE_WORDS);
  printf(", \"UPPERCASE_SENTENCES\": %u",
         (unsigned)IBUS_INPUT_HINT_UPPERCASE_SENTENCES);
  printf(", \"INHIBIT_OSK\": %u", (unsigned)IBUS_INPUT_HINT_INHIBIT_OSK);
  printf(", \"VERTICAL_WRITING\": %u",
         (unsigned)IBUS_INPUT_HINT_VERTICAL_WRITING);
  printf(", \"EMOJI\": %u", (unsigned)IBUS_INPUT_HINT_EMOJI);
  printf(", \"NO_EMOJI\": %u", (unsigned)IBUS_INPUT_HINT_NO_EMOJI);
  printf(", \"PRIVATE\": %u", (unsigned)IBUS_INPUT_HINT_PRIVATE);
  printf(", \"HIDDEN_TEXT\": %u", (unsigned)IBUS_INPUT_HINT_HIDDEN_TEXT);
  printf(", \"LATIN\": %u", (unsigned)IBUS_INPUT_HINT_LATIN);
  printf(", \"MULTILINE\": %u", (unsigned)IBUS_INPUT_HINT_MULTILINE);
  printf("}");
  printf("}\n");
  return 0;
}
