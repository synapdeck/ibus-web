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

      # The Nix and cache actions release together; mismatched versions are
      # untested against each other.
      determinateVersion = "v3.23.0";

      checkout = {
        name = "Check out";
        uses = "actions/checkout@v7.0.1";
      };
      installNix = {
        name = "Install Determinate Nix";
        uses = "DeterminateSystems/determinate-nix-action@${determinateVersion}";
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
          # A pull request's new push makes its running checks moot; every
          # push to master keeps its own run, since it may publish.
          concurrency = {
            group = "\${{ github.workflow }}-\${{ github.event.pull_request.number || github.run_id }}";
            cancelInProgress = true;
          };
          jobs.check = {
            name = "nix flake check";
            runsOn = "ubuntu-latest";
            # Stops a hung check well before GitHub's six hours, with room
            # for a cold run, which rebuilds the patched Emscripten, its
            # cache and everything WASM.
            timeoutMinutes = 240;
            steps = [
              checkout
              installNix
              # Ubuntu 24.04's AppArmor forbids unprivileged user namespaces,
              # which Chromium's sandbox needs, and the browser checks keep
              # that sandbox on. A runner image without the setting has no
              # ban to lift.
              {
                name = "Allow unprivileged user namespaces";
                run = "if sysctl -n kernel.apparmor_restrict_unprivileged_userns >/dev/null 2>&1; then sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0; fi";
              }
              # GitHub's token for a pull request from a fork lacks the
              # claims FlakeHub Cache needs, so those runs build without it.
              {
                name = "Use FlakeHub Cache";
                uses = "DeterminateSystems/flakehub-cache-action@${determinateVersion}";
              }
              # Runners are x86_64-linux; the other systems' checks need
              # their own machines.
              {
                name = "Check";
                run = "nix flake check -L --system x86_64-linux";
              }
            ];
          };

          # FlakeHub Cache grants access per published flake, so the cache
          # needs this one published, privately; only a master that passed
          # its checks is published.
          jobs.publish = {
            name = "Publish to FlakeHub";
            needs = [ "check" ];
            if_ = "github.event_name == 'push' && github.ref == 'refs/heads/master'";
            runsOn = "ubuntu-latest";
            timeoutMinutes = 30;
            steps = [
              checkout
              installNix
              # flakehub-push is tagged by major version only, so it can't be
              # pinned to a release as the other actions are.
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
