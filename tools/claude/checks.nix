# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{
  perSystem =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      root = ../..;
      readJson = path: builtins.fromJSON (builtins.readFile path);

      settings = readJson (root + "/.claude/settings.json");
      marketplace = readJson (root + "/.claude-plugin/marketplace.json");

      # Claude Code resolves a directory marketplace's path against the
      # project root, and each plugin's source against the marketplace's.
      source = settings.extraKnownMarketplaces.${marketplace.name}.source;
      manifestOf = plugin: readJson (root + "/${plugin.source}/.claude-plugin/plugin.json");

      enabled = lib.filter (lib.hasSuffix "@${marketplace.name}") (
        builtins.attrNames settings.enabledPlugins
      );
      listed = map (plugin: "${plugin.name}@${marketplace.name}") marketplace.plugins;

      # Every language server a plugin names, which the dev shell must put
      # on PATH.
      commands = lib.concatMap (
        plugin: lib.mapAttrsToList (_: server: server.command) (manifestOf plugin).lspServers
      ) marketplace.plugins;

      mismatched = lib.filter (
        plugin:
        let
          manifest = manifestOf plugin;
        in
        manifest.name != plugin.name || manifest.version != plugin.version
      ) marketplace.plugins;
    in
    {
      checks.tools-claude-plugins =
        assert lib.assertMsg (
          source.source == "directory" && source.path == "."
        ) ".claude/settings.json must name this repository's root as the ${marketplace.name} marketplace";
        assert lib.assertMsg (mismatched == [ ])
          "plugins whose plugin.json disagrees with the marketplace: ${
            toString (map (p: p.name) mismatched)
          }";
        assert lib.assertMsg (
          lib.subtractLists listed enabled == [ ]
        ) "enabled but not in the marketplace: ${toString (lib.subtractLists listed enabled)}";
        pkgs.runCommand "ibus-web-tools-claude-plugins"
          {
            nativeBuildInputs = config.devshells.default.packages;
          }
          ''
            for command in ${lib.escapeShellArgs commands}; do
              command -v "$command" > /dev/null || {
                echo "the dev shell doesn't provide $command, which a plugin runs" >&2
                exit 1
              }
            done
            touch $out
          '';
    };
}
