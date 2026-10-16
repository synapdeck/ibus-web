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

      # What a release ships is built from more than the published packages'
      # directories, which for the runtime and the engines hold only a
      # package.json: also from their sources and the shared build modules.
      # The flake's own modules (CI, the file writer), tests and checks ship
      # nothing.
      shippedPaths = map (dir: "${dir}/") config.ibusWeb.typescript.publishedPackages ++ [
        "runtime/"
        "engines/"
        "modules/"
      ];
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
            # A pull request that changes what a release ships must add a
            # changeset; one that changes it without a release note adds an
            # empty one (`changeset --empty`). Removing changesets is
            # versioning, which needs none.
            changesets = {
              name = "Changeset";
              if_ = "github.event_name == 'pull_request'";
              runsOn = "ubuntu-latest";
              timeoutMinutes = 5;
              inherit permissions;
              steps = [
                (
                  checkout
                  // {
                    with_.fetch-depth = 0;
                  }
                )
                {
                  name = "Check";
                  env.BASE = "\${{ github.event.pull_request.base.sha }}";
                  run = ''
                    shipped=$(git diff --name-only "$BASE"...HEAD -- ${
                      lib.concatMapStringsSep " " (path: "':(top)${path}'") shippedPaths
                    } ':(exclude,top)modules/flake/' ':(exclude,top,glob)**/test/**' ':(exclude,top,glob)**/checks/**')
                    if [ -z "$shipped" ]; then
                      echo "Nothing a release ships changed."
                    elif git diff --name-only --diff-filter=AD "$BASE"...HEAD -- '.changeset/*.md' | grep -q .; then
                      echo "A changeset covers this change."
                    else
                      echo "::error::This changes what a release ships but adds no changeset. Run \`changeset\`, or \`changeset --empty\` if it needs no release note."
                      printf '%s\n' "$shipped"
                      exit 1
                    fi
                  '';
                }
              ];
            };

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
            # system at macOS's price. It and the Safari job wait for the
            # macOS check, so they substitute the WebAssembly it built from
            # FlakeHub Cache instead of each building it again.
            playwright-macos =
              nixJob {
                name = "Playwright (aarch64-darwin)";
                system = "aarch64-darwin";
                steps = [
                  {
                    name = "Check";
                    run = "nix build .#packages.aarch64-darwin.playwright-integration -L --max-jobs 1";
                  }
                ];
              }
              // {
                needs = [ "check-aarch64-darwin" ];
              };

            # Playwright's WebKit isn't Safari: this drives the real one
            # through safaridriver, against the production demo. safaridriver
            # serves one session at a time and must be enabled first, as root.
            safari =
              nixJob {
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
              }
              // {
                needs = [ "check-aarch64-darwin" ];
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

        # A tag publishes what `.#release` built from it: the GitHub release,
        # then each npm tarball. Publishing builds nothing, and npm's trusted
        # publishing trades the job's OIDC token for a short-lived
        # credential, so no npm token is stored, and npm attaches provenance.
        # npm trusts only GitHub-hosted runners, so the tarballs move to one
        # for the publish.
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
                # The upload doesn't follow the result symlink's directory.
                {
                  name = "Collect the npm tarballs";
                  run = "mkdir npm && cp release/assets/*.tgz npm/";
                }
                {
                  name = "Upload the npm tarballs";
                  uses = "actions/upload-artifact@v7.0.2";
                  with_ = {
                    name = "npm";
                    path = "npm/*.tgz";
                    if-no-files-found = "error";
                  };
                }
              ];
            }
            // {
              permissions = {
                contents = "write";
                id-token = "write";
              };
            };

          # Trusted publishing needs npm 11.5.1 or later, which the
          # workspace's Node carries; the job installs that same release. A
          # version already on the registry is skipped, so rerunning the job
          # after a partial publish finishes it.
          jobs.npm = {
            name = "Publish to npm";
            needs = [ "release" ];
            runsOn = "ubuntu-latest";
            timeoutMinutes = 30;
            permissions = {
              contents = "read";
              id-token = "write";
            };
            steps = [
              {
                name = "Install Node";
                uses = "actions/setup-node@v7.1.0";
                with_.node-version = config.ibusWeb.typescript.nodejs.version;
              }
              {
                name = "Download the npm tarballs";
                uses = "actions/download-artifact@v8.0.2";
                with_ = {
                  name = "npm";
                  path = "npm";
                };
              }
              {
                name = "Publish";
                run = ''
                  for tarball in npm/*.tgz; do
                    spec=$(tar -xOzf "$tarball" package/package.json | jq -r '.name + "@" + .version')
                    if [ -n "$(npm view "$spec" version 2>/dev/null)" ]; then
                      echo "$spec is already published"
                    else
                      npm publish "$tarball" --access public
                    fi
                  done
                '';
              }
            ];
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
