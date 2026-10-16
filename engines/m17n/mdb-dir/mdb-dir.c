/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later */

/* Prints an mdb.dir entry for each input method m17n finds through its
 * database's wildcard: its tags, its file and the version it requires.
 * m17n reads every input method's file to its end to expand the wildcard,
 * the first time it looks any of them up; entries that name each file let
 * it open only the files it needs. */
#include <m17n.h>
#include <stdio.h>
#include <string.h>

/* m17n-lib's own, which its installed headers don't declare. */
char *mdatabase__file(MDatabase *mdb);
MPlist *mdatabase__props(MDatabase *mdb);

static void quoted(const char *text) {
  putchar('"');
  for (const char *c = text; *c != '\0'; c++) {
    if (*c == '"' || *c == '\\')
      putchar('\\');
    putchar(*c);
  }
  putchar('"');
}

/* The version an entry requires, which m17n checks as it registers one. */
static void version(MPlist *props) {
  MSymbol key = msymbol("version");
  for (MPlist *p = props; p != NULL && mplist_key(p) != Mnil;
       p = mplist_next(p)) {
    if (mplist_key(p) != Mplist)
      continue;

    MPlist *pair = mplist_value(p);
    if (mplist_key(pair) != Msymbol || mplist_value(pair) != key ||
        mplist_key(mplist_next(pair)) != Mtext)
      continue;

    unsigned char text[64];
    int length = mconv_encode_buffer(
        Mcoding_utf_8, mplist_value(mplist_next(pair)), text, sizeof text - 1);
    if (length < 0)
      continue;
    text[length] = '\0';
    fputs(" (version ", stdout);
    quoted((const char *)text);
    putchar(')');
  }
}

int main(void) {
  M17N_INIT();
  if (merror_code != 0) {
    fputs("m17n failed to start\n", stderr);
    return 1;
  }

  MPlist *list = mdatabase_list(msymbol("input-method"), Mnil, Mnil, Mnil);
  int count = 0;
  for (MPlist *p = list; p != NULL && mplist_key(p) != Mnil;
       p = mplist_next(p)) {
    MDatabase *mdb = mplist_value(p);
    MSymbol *tags = mdatabase_tag(mdb);
    const char *file = mdatabase__file(mdb);
    if (file == NULL) {
      fprintf(stderr, "no file for input method %s %s\n", msymbol_name(tags[1]),
              msymbol_name(tags[2]));
      return 1;
    }

    /* Trailing nil tags are left out, as a wildcard entry leaves them. */
    int last = 3;
    while (last > 0 && tags[last] == Mnil)
      last--;
    fputs("(input-method", stdout);
    for (int i = 1; i <= last; i++)
      printf(" %s", msymbol_name(tags[i]));

    const char *slash = strrchr(file, '/');
    putchar(' ');
    quoted(slash == NULL ? file : slash + 1);
    version(mdatabase__props(mdb));
    puts(")");
    count++;
  }

  m17n_object_unref(list);
  M17N_FINI();
  return count > 0 ? 0 : 1;
}
