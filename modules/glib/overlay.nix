# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{ lib, ... }:
{
  flake.overlays.glib =
    final: prev:
    lib.optionalAttrs
      (prev.stdenv.hostPlatform.isWasm && (prev.stdenv.hostPlatform.useEmscripten or false))
      {
        glib = prev.glib.overrideAttrs (
          old:
          let
            # Built for the host they'd be for a native GLib, these have no use
            # in the browser; Emscripten's musl provides iconv and gettext.
            unwanted = [
              "bash-interactive"
              "gnum4"
              "libsysprof-capture"
              "gettext"
              "libiconv"
            ];
            # The lists also hold GLib's setup hook, a path with no name.
            keep = deps: lib.filter (d: !(lib.isDerivation d && lib.elem (lib.getName d) unwanted)) deps;
            # GLib's executables (its tools, and its tests when enabled) only
            # ever run under Node, so they get a real filesystem and threads
            # that start without returning to the event loop. Static
            # libraries don't see link arguments.
            nodeLinkArgs = "-sNODERAWFS=1 -sEXIT_RUNTIME=1 -sPTHREAD_POOL_SIZE=8 -sALLOW_MEMORY_GROWTH=1";
            # The tools are named after the program with Emscripten's .js
            # suffix, and nixpkgs files their completions and man pages by
            # program name.
            programName = lib.replaceStrings [ "\${i##*/}" ] [ "$(basename \"$i\" .js)" ];
          in
          {
            # Sorted by name, so 0001-… applies first; README.md is not a patch.
            patches =
              (old.patches or [ ])
              ++ lib.filter (p: lib.hasSuffix ".patch" (toString p)) (
                lib.filesystem.listFilesRecursive ./patches
              );
            # With documentation off nothing lands in devdoc, and Nix fails a
            # build that leaves an output unwritten.
            outputs = lib.remove "devdoc" old.outputs;
            postInstall = programName old.postInstall;
            postFixup = programName (
              lib.replaceStrings [ "moveToOutput \"share/doc\" \"$devdoc\"" ] [ "" ] old.postFixup
            );
            buildInputs = keep (old.buildInputs or [ ]);
            propagatedBuildInputs = keep (old.propagatedBuildInputs or [ ]);
            mesonFlags = (old.mesonFlags or [ ]) ++ [
              "-Dnls=disabled"
              "-Dsysprof=disabled"
              "-Ddocumentation=false"
              "-Dtests=false"
              # Emscripten's libc has no getxattr, and GLib refuses to configure
              # with xattr support it can't find.
              "-Dxattr=false"
              "-Dc_link_args=${nodeLinkArgs}"
              "-Dcpp_link_args=${nodeLinkArgs}"
            ];
          }
        );
      };
}
