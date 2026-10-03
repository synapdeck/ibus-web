# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{ inputs, lib, ... }:
{
  imports = [ inputs.github-actions-nix.flakeModules.default ];

  perSystem =
    { config, ... }:
    let
      # Determinate Nix and FlakeHub Cache authenticate with the job's OIDC
      # token.
      permissions = {
        contents = "read";
        id-token = "write";
      };

      checkout = {
        name = "Check out";
        uses = "actions/checkout@v5";
      };
      installNix = {
        name = "Install Determinate Nix";
        uses = "DeterminateSystems/determinate-nix-action@v3";
      };
    in
    {
      githubActions = {
        enable = true;

        workflows.ci = {
          name = "CI";
          on = {
            pullRequest = { };
            push.branches = [ "master" ];
          };
          inherit permissions;
          jobs.check = {
            name = "nix flake check";
            runsOn = "ubuntu-latest";
            steps = [
              checkout
              installNix
              # GitHub's token for a pull request from a fork lacks the
              # claims FlakeHub Cache needs, so those runs build without it.
              {
                name = "Use FlakeHub Cache";
                uses = "DeterminateSystems/flakehub-cache-action@v3.23.0";
              }
              # Runners are x86_64-linux; the other systems' checks need
              # their own machines.
              {
                name = "Check";
                run = "nix flake check -L --system x86_64-linux";
              }
            ];
          };
        };

        # FlakeHub Cache grants access per published flake, so the cache
        # needs this one published, privately.
        workflows.publish = {
          name = "Publish to FlakeHub";
          on.push.branches = [ "master" ];
          inherit permissions;
          jobs.publish = {
            name = "Publish to FlakeHub";
            runsOn = "ubuntu-latest";
            steps = [
              checkout
              installNix
              {
                name = "Publish";
                uses = "DeterminateSystems/flakehub-push@v7";
                with_ = {
                  name = "synapdeck/ibus-web";
                  visibility = "private";
                  rolling = true;
                };
              }
            ];
          };
        };
      };

      files.file = lib.mapAttrs' (
        file: source: lib.nameValuePair ".github/workflows/${file}" { inherit source; }
      ) config.githubActions.workflowFiles;
    };
}
