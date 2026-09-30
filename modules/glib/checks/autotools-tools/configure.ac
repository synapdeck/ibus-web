dnl SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
dnl SPDX-License-Identifier: MIT OR Apache-2.0
AC_INIT([glib-tools-consumer], [1])
PKG_PROG_PKG_CONFIG
PKG_CHECK_VAR([GLIB_COMPILE_SCHEMAS], [gio-2.0], [glib_compile_schemas])
PKG_CHECK_VAR([GLIB_COMPILE_RESOURCES], [gio-2.0], [glib_compile_resources])
PKG_CHECK_VAR([GSETTINGS], [gio-2.0], [gsettings])
PKG_CHECK_VAR([GRESOURCE], [gio-2.0], [gresource])
AS_IF([test -z "$GLIB_COMPILE_SCHEMAS" || test -z "$GLIB_COMPILE_RESOURCES" ||
       test -z "$GSETTINGS" || test -z "$GRESOURCE"],
      [AC_MSG_ERROR([gio-2.0 does not name every tool])])
AC_CONFIG_FILES([Makefile])
AC_OUTPUT
