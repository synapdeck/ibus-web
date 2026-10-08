# Security

## Reporting a vulnerability

Report security problems privately. Don't open a public issue or pull request for them.

Email [security@synapdeck.com](mailto:security@synapdeck.com). Once the repository is public, you can also use GitHub's
private vulnerability reporting: [open a draft security advisory](https://github.com/synapdeck/ibus-web/security/advisories/new).

Include:

- what is affected: a package, the Worker host, the runtime, an engine's patches, or the build;
- the version or commit;
- how to reproduce it, and what an attacker gains.

A maintainer replies in the advisory and coordinates the fix and its disclosure there.

## Scope

ibus-web runs engines in dedicated Workers and keeps their code out of the page's bundle. Problems that let engine or
Worker code reach the page, or let one page's input reach another origin, are in scope, as are problems in the
packages, the runtime and the patches this repository carries.

A vulnerability in an upstream project ibus-web builds on (Emscripten, GLib, IBus, an engine) belongs with that
project; tell us too if ibus-web ships the affected code.

## Supported versions

Nothing has been released yet. Fixes land on `master`.
