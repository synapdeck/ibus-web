dnl SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
dnl SPDX-License-Identifier: MIT OR Apache-2.0
AC_INIT([autotools-consumer], [1])
AM_INIT_AUTOMAKE([foreign])
AC_PROG_CC

dnl A test program's exit status and output, which only running it gives.
AC_MSG_CHECKING([what a test program reports])
AC_RUN_IFELSE(
  [AC_LANG_PROGRAM([[#include <stdio.h>]], [[
#ifndef __EMSCRIPTEN__
  return 1;
#endif
  FILE *f = fopen("conftest.out", "w");
  if (f == NULL)
    return 2;
  fprintf(f, "%d", (int)sizeof(void *));
  return fclose(f) != 0;
]])],
  [consumer_ran=$(cat conftest.out)],
  [AC_MSG_ERROR([the test program failed])],
  [AC_MSG_ERROR([configure didn't run the test program])])
AC_MSG_RESULT([$consumer_ran])
AC_SUBST([CONSUMER_POINTER_SIZE], [$consumer_ran])

AC_CONFIG_FILES([Makefile])
AC_OUTPUT
