# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

# Meson's gnome module takes GLib's tools (gdbus-codegen,
# glib-compile-resources, glib-mkenums, …) from the host machine's cross
# files before the pkg-config variables of the build machine's GLib, so this
# GLib's tools run instead of that one's, which lack its fixes: its
# gdbus-codegen, for one, emits one-argument interface init functions,
# which WebAssembly traps on calling.
mesonFlagsArray+=("--cross-file=@dev@/nix-support/glib-tools-cross.ini")

# The gnome module also picks tool options by the build machine's GLib
# version, which Meson reads through the build machine's pkg-config, and
# assumes 2.54 without one. A consumer's own build-machine pkg-config wins.
export PKG_CONFIG_FOR_BUILD=${PKG_CONFIG_FOR_BUILD:-@buildPkgConfig@}
addToSearchPath PKG_CONFIG_PATH_FOR_BUILD @buildGlibPkgConfigPath@

# A build that runs a tool by plain name gets this GLib's too. stdenv puts
# its build inputs' bin directories, the build machine's GLib's among them,
# ahead of anything a setup hook adds, so this waits until setup is done.
_glibToolsFirstOnPath() {
  export PATH="@dev@/bin:@bin@/bin${PATH:+:}$PATH"
}
postHooks+=(_glibToolsFirstOnPath)
