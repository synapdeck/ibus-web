# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  lib,
  stdenv,
  meson,
  ninja,
  pkg-config,
  glib,
}:
let
  # Meson's project() declares the version.
  versions = lib.concatMap (
    line:
    let
      match = builtins.match " *version: '([^']*)',?" line;
    in
    lib.optional (match != null) (builtins.head match)
  ) (lib.splitString "\n" (builtins.readFile ./meson.build));
  fileset = lib.fileset.unions [
    ./meson.build
    ./meson.options
    ./include
    ./src
  ];
in
assert lib.length versions == 1;
stdenv.mkDerivation {
  pname = "libibus-web";
  version = builtins.head versions;
  src = lib.fileset.toSource {
    root = ./.;
    inherit fileset;
  };
  passthru = { inherit fileset; };
  nativeBuildInputs = [
    meson
    ninja
    pkg-config
  ];
  # Consumers compile against GLib headers and link its static libraries.
  propagatedBuildInputs = [ glib ];
}
