# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

# Meson's gnome.gdbus_codegen() takes gdbus-codegen from the host machine's
# cross files before gio-2.0's pkg-config variable, which it reads from the
# build machine's GLib. That GLib's gdbus-codegen emits one-argument
# interface init functions, which WebAssembly traps on calling; this GLib's
# emits ones it can call.
mesonFlagsArray+=("--cross-file=@dev@/nix-support/gdbus-codegen-cross.ini")

# gnome.gdbus_codegen() also picks its options by the build machine's GLib
# version, which Meson reads through the build machine's pkg-config, and
# assumes 2.54 without one. A consumer's own build-machine pkg-config wins.
export PKG_CONFIG_FOR_BUILD=${PKG_CONFIG_FOR_BUILD:-@buildPkgConfig@}
addToSearchPath PKG_CONFIG_PATH_FOR_BUILD @buildGlibPkgConfigPath@
