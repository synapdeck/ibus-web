# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

# Meson's gnome.gdbus_codegen() takes gdbus-codegen from the host machine's
# cross files before gio-2.0's pkg-config variable, which it reads from the
# build machine's GLib. That GLib's gdbus-codegen emits one-argument
# interface init functions, which WebAssembly traps on calling; this GLib's
# emits ones it can call.
mesonFlagsArray+=("--cross-file=@dev@/nix-support/gdbus-codegen-cross.ini")
