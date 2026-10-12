# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.toolchain = {
      emscripten = lib.mkOption {
        type = lib.types.package;
        description = "nixpkgs' Emscripten with the upstream-tracked fixes this project carries; every WASM build's compiler.";
      };
      commonFlags = lib.mkOption {
        type = lib.types.str;
        description = "Compiler flags every WASM object is built with.";
      };
      minimumVersions = lib.mkOption {
        type = lib.types.package;
        description = ''
          The oldest browsers and Node every link targets, as Emscripten's MIN_*_VERSION
          settings: the browsers Baseline Widely available covered on the date of
          baseline-browser-mapping's data, raised to any floor set for a browser, and the
          workspace's Node. It holds date, that
          date; versions.json, the four versions; and link-flags, one line of the
          -sMIN_*_VERSION flags. pkgsWasm's compilers add them to every link.
        '';
      };
      minimumVersionFlags = lib.mkOption {
        type = lib.types.str;
        description = "Shell text that a build script expands to minimumVersions' link flags, for links that call emcc or em++ directly.";
      };
      testMainFlags = lib.mkOption {
        type = lib.types.str;
        description = "Link flags for Node-run test programs, on WasmFS; a combination the library cache covers.";
      };
      testMainFlagList = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        description = "testMainFlags, one flag an element, for links that leave some out.";
      };
      dynamicLinkFlags = lib.mkOption {
        type = lib.types.str;
        description = "Link flags every main or side module link adds, acknowledging that Emscripten's dynamic linking is experimental.";
      };
      runtimeMainFlags = lib.mkOption {
        type = lib.types.str;
        description = "The settings of ibus-runtime's main-module link that select library variants; the cache holds them with and without assertions.";
      };
      sideModuleFlags = lib.mkOption {
        type = lib.types.str;
        description = "Link flags for side modules a main module loads with dlopen().";
      };
      testMemoryFlags = lib.mkOption {
        type = lib.types.str;
        description = "Link flags giving Node-run test programs and GLib's tools a fixed memory large enough for GLib's tests, in place of memory growth.";
      };
      nodeHostFsFlags = lib.mkOption {
        type = lib.types.str;
        description = "Link flags putting a Node-run program on WasmFS with the host's files at their own paths.";
      };
      emscriptenCache = lib.mkOption {
        type = lib.types.package;
        description = "Emscripten cache prebuilt for this project's library variants.";
      };
      emscriptenCacheHook = lib.mkOption {
        type = lib.types.package;
        description = "Setup hook giving each build a private copy of the cache.";
      };
      mesonCrossFlags = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        description = "Meson flags selecting pkgsWasm's cross files, for configuring by hand.";
      };
      devLibraries = lib.mkOption {
        type = lib.types.listOf lib.types.package;
        default = [ ];
        description = "pkgsWasm libraries whose headers and pkg-config files the dev shell and editor see.";
      };
      clangdPathFlags = lib.mkOption {
        type = lib.types.attrsOf (lib.types.listOf lib.types.str);
        default = { };
        description = "Compiler flags the editor adds for sources whose repository-relative paths match each key, a regular expression, beyond the flags every loose source gets: for sources built with flags of their own, such as include paths into the toolchain.";
      };
      clangdFragments = lib.mkOption {
        type = lib.types.listOf lib.types.path;
        default = [ ];
        description = "Generated clangd configuration fragments for sources using a different compiler than the WASM default.";
      };
      clangdQueryDrivers = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        description = "Additional compiler paths clangd may query for target and system include directories.";
      };
      pkgsWasm = lib.mkOption {
        type = lib.types.raw;
        description = "nixpkgs for wasm32-unknown-none, compiled with Emscripten.";
      };
    };
  };
}
