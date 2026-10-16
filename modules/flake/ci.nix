# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{ inputs, lib, ... }:
{
  imports = [ inputs.github-actions-nix.flakeModules.default ];

  perSystem =
    { config, ... }:
    let
      # Each job sets its own: Determinate Nix and FlakeHub authenticate with
      # the job's OIDC token, which a job that doesn't use them shouldn't get.
      permissions = {
        contents = "read";
      };
      flakehubPermissions = {
        contents = "read";
        id-token = "write";
      };

      # WarpBuild's runners: their 150 GB of disk holds a cold run, which
      # rebuilds the patched Emscripten and everything WebAssembly; eight
      # cores keep one inside the timeout. macOS comes in one size.
      runners = {
        x86_64-linux = "warp-ubuntu-latest-x64-8x";
        aarch64-linux = "warp-ubuntu-latest-arm64-8x";
        aarch64-darwin = "warp-macos-26-arm64-6x";
      };
      systems = lib.attrNames runners;

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
      # GitHub's token for a pull request from a fork lacks the claims
      # FlakeHub Cache needs, so those runs build without it.
      useCache = {
        name = "Use FlakeHub Cache";
        uses = "DeterminateSystems/flakehub-cache-action@${determinateVersion}";
      };
      # Ubuntu 24.04's AppArmor forbids unprivileged user namespaces, which
      # Chromium's sandbox needs, and the browser checks keep that sandbox
      # on. A runner image without the setting has no ban to lift.
      allowUserNamespaces = {
        name = "Allow unprivileged user namespaces";
        run = "if sysctl -n kernel.apparmor_restrict_unprivileged_userns >/dev/null 2>&1; then sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0; fi";
      };

      # A job that builds with Nix on one system's runner. Cold compilation
      # and CPU-bound test checks must not compete for the runner's cores,
      # so its commands build one derivation at a time. The timeout stops a
      # hung check with room for a cold run.
      nixJob =
        {
          name,
          system,
          steps,
        }:
        {
          inherit name;
          runsOn = runners.${system};
          timeoutMinutes = 360;
          permissions = flakehubPermissions;
          steps = [
            checkout
            installNix
          ]
          ++ lib.optional (lib.hasSuffix "-linux" system) allowUserNamespaces
          ++ [ useCache ]
          ++ steps;
        };

      checkJob =
        system:
        nixJob {
          name = "nix flake check (${system})";
          inherit system;
          steps = [
            {
              name = "Check";
              run = "nix flake check -L --system ${system} --max-jobs 1";
            }
          ];
        };

      checkJobs = lib.listToAttrs (
        map (system: lib.nameValuePair "check-${system}" (checkJob system)) systems
      );
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
          jobs = checkJobs // {
            integration = nixJob {
              name = "extended integration";
              system = "x86_64-linux";
              steps = [
                {
                  name = "Check";
                  run = "nix build .#integration-checks -L --max-jobs 1";
                }
              ];
            };

            # Playwright's WebKit on macOS is closer to Safari than its Linux
            # build; the other extended checks gain nothing from a second
            # system at macOS's price.
            playwright-macos = nixJob {
              name = "Playwright (aarch64-darwin)";
              system = "aarch64-darwin";
              steps = [
                {
                  name = "Check";
                  run = "nix build .#packages.aarch64-darwin.playwright-integration -L --max-jobs 1";
                }
              ];
            };

            # Playwright's WebKit isn't Safari: this drives the real one
            # through safaridriver, against the production demo. safaridriver
            # serves one session at a time and must be enabled first, as root.
            safari = nixJob {
              name = "Safari smoke";
              system = "aarch64-darwin";
              steps = [
                {
                  name = "Enable safaridriver";
                  run = "sudo safaridriver --enable";
                }
                {
                  name = "Smoke";
                  run = "nix run .#safari-smoke -L";
                }
              ];
            };

            # FlakeHub Cache grants access per published flake, so the cache
            # needs this one published; only a master that passed its checks
            # is.
            publish = {
              name = "Publish to FlakeHub";
              needs = lib.attrNames checkJobs ++ [
                "integration"
                "playwright-macos"
                "safari"
              ];
              if_ = "github.event_name == 'push' && github.ref == 'refs/heads/master'";
              runsOn = runners.x86_64-linux;
              timeoutMinutes = 30;
              permissions = flakehubPermissions;
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
                    # The flake is as visible as the repository: private while
                    # it is, listed once it is public.
                    visibility = "\${{ github.event.repository.private && 'private' || 'public' }}";
                    rolling = true;
                  };
                }
              ];
            };
          };
        };

        # A tag publishes what `.#release` built from it (design spec §10.5):
        # the GitHub release, then each npm tarball. Publishing builds
        # nothing, and npm's trusted publishing trades the job's OIDC token
        # for a short-lived credential, so no npm token is stored, and npm
        # attaches provenance.
        workflows.release = {
          name = "Release";
          on.push.tags = [ "v*" ];
          inherit permissions;
          concurrency = {
            group = "release";
            cancelInProgress = false;
          };

          jobs.release =
            nixJob {
              name = "Release";
              system = "x86_64-linux";
              steps = [
                {
                  name = "Build";
                  run = "nix build .#release -L --max-jobs 1 -o release";
                }
                {
                  name = "Check the tag against the version";
                  run = ''test "v$(nix eval --raw .#release.passthru.version)" = "$GITHUB_REF_NAME"'';
                }
                {
                  name = "Create the GitHub release";
                  run = ''gh release create "$GITHUB_REF_NAME" --verify-tag --title "$GITHUB_REF_NAME" --notes-file release/notes.md release/assets/*'';
                  env.GH_TOKEN = "\${{ github.token }}";
                }
                # Trusted publishing needs npm 11.5.1 or later, which the
                # workspace's Node carries.
                {
                  name = "Publish to npm";
                  run = ''
                    for tarball in release/assets/*.tgz; do
                      nix shell --inputs-from . nixpkgs#nodejs_26 -c npm publish "$tarball" --access public
                    done
                  '';
                }
              ];
            }
            // {
              permissions = {
                contents = "write";
                id-token = "write";
              };
            };
        };

        # Builds the release's WebAssembly again and compares it with what
        # the first build made, to catch an output that isn't reproducible.
        # `--rebuild` compares only the derivations it names. Until a
        # release's changelogs exist, `.#release` has no notes to build.
        workflows.reproducibility = {
          name = "Reproducibility";
          on = {
            schedule = [ { cron = "17 5 * * 1"; } ];
            workflowDispatch = { };
          };
          inherit permissions;

          jobs.rebuild = nixJob {
            name = "Rebuild the release";
            system = "x86_64-linux";
            steps =
              let
                modules = ".#ibus-runtime .#ibus-web-hangul .#ibus-web-m17n .#ibus-web-mozc .#ibus-web-rime .#ibus-web-table";
                hasChangelog = "hashFiles('packages/ibus-web/CHANGELOG.md') != ''";
              in
              [
                {
                  name = "Build";
                  run = "nix build ${modules} -L --max-jobs 1 --no-link";
                }
                {
                  name = "Rebuild";
                  run = "nix build --rebuild ${modules} -L --max-jobs 1 --no-link";
                }
                {
                  name = "Rebuild the release";
                  if_ = hasChangelog;
                  run = "nix build .#release -L --max-jobs 1 --no-link && nix build --rebuild .#release -L --max-jobs 1 --no-link";
                }
              ];
          };
        };
      };

      files.file =
        lib.mapAttrs' (
          file: source: lib.nameValuePair ".github/workflows/${file}" { inherit source; }
        ) config.githubActions.workflowFiles
        // {
          # actionlint knows GitHub's own runner labels only.
          ".github/actionlint.yaml".text = ''
            # SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
            # SPDX-License-Identifier: MIT OR Apache-2.0
            #
            # Generated from modules/flake/ci.nix by `nix run .#write-files`.
            self-hosted-runner:
              labels:
            ${lib.concatMapStrings (label: "    - ${label}\n") (lib.unique (lib.attrValues runners))}'';
        };
    };
}
