# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
"""Compare a Meson test log with the committed baseline.

Only tests listed under must_pass gate the build; excluded tests carry the
reason they cannot run here and are never run, and every other result is
reported but informational.

TESTS is Meson's introspection file (meson-info/intro-tests.json), which
gives each test's name and suites as data, where a log name is formatted
text. LIST is the output of `meson test --no-rebuild --list`: the log names
of the tests a plain `meson test` runs, after the default test setup's
excluded suites. Only those count as the build's tests. SUITES names those
excluded suites, one per line.

    gate.py runnable TESTS LIST SUITES BASELINE
        print `meson test` invocations, one per line, that together run
        every test not excluded
    gate.py failing TESTS LIST SUITES BASELINE TESTLOG
        print invocations that rerun the must_pass tests that ran and did
        not pass
    gate.py report TESTS LIST SUITES BASELINE TESTLOG OUT_DIR [RERUN]
        write summary.txt and proposed-baseline.toml; fail on a gating
        failure

A must_pass test that fails in the parallel run but passes in the rerun
counts as passed and is reported as flaky: under the parallel run's load,
tests that assert wall-clock bounds miss them.
"""

import json
import re
import sys
from pathlib import Path

import tomllib

PASSING = ("OK", "EXPECTEDFAIL")


def read_log(path):
    results = {}
    for line in path.read_text().splitlines():
        if line.strip():
            entry = json.loads(line)
            results[entry["name"]] = entry["result"]
    return results


def split_suite(suite):
    project, _, name = suite.partition(":")
    return project, name


class Test:
    def __init__(self, entry):
        self.name = entry["name"]
        self.suites = entry["suite"]
        self.project = split_suite(self.suites[0])[0]
        self.short = f"{self.project}:{self.name}"
        # Meson's log name: "<suite>+<suite> - <project>:<name>".
        names = [s for s in (split_suite(s)[1] for s in self.suites) if s]
        self.log_name = f"{'+'.join(names)} - {self.short}" if names else self.short


def check_word(kind, value):
    # The shell reads each invocation into words, so a space would split one
    # argument into two.
    if re.search(r"\s", value):
        sys.exit(f"gate: {kind} {value!r} contains whitespace")


def read_tests(path, list_path):
    tests = {t.log_name: t for t in map(Test, json.loads(path.read_text()))}
    listed = list_path.read_text().splitlines()
    unknown = [name for name in listed if name not in tests]
    if unknown:
        sys.exit("gate: listed tests missing from the introspection file: " + ", ".join(unknown))
    for name in listed:
        check_word("test name", tests[name].name)
        check_word("project name", tests[name].project)
    return {name: tests[name] for name in listed}


def read_suites(path):
    suites = [line for line in path.read_text().splitlines() if line]
    for suite in suites:
        check_word("excluded suite", suite)
    return suites


def pattern(test):
    # meson test matches "<project>:<name>" arguments with fnmatch.
    def escape(s):
        return re.sub(r"([*?\[])", r"[\1]", s)

    return f"{escape(test.project)}:{escape(test.name)}"


def invocations(targets, tests, excluded_suites):
    """Argument lists for `meson test` that together run exactly `targets`.

    meson test selects by "<project>:<name>" alone, and some names repeat
    across suites. A name whose every holder is a target joins one shared
    invocation; any other target runs in its own, narrowed with --suite to
    a suite that none of the name's other holders is in. A bare project
    suite never narrows: --suite takes it to mean every test of the
    project.

    --suite also sets aside the default test setup's excluded suites, so
    every invocation excludes them itself with --no-suite.
    """
    targets = set(targets)
    holders = {}
    for test in tests.values():
        holders.setdefault(test.short, []).append(test)

    shared, alone, covered = [], [], set()
    for log_name in sorted(targets):
        if log_name in covered:
            continue
        test = tests[log_name]
        same = holders[test.short]
        others = [t for t in same if t.log_name not in targets]
        if not others:
            shared.append(pattern(test))
            covered.update(t.log_name for t in same)
            continue
        suite = next(
            (s for s in test.suites if ":" in s and all(s not in o.suites for o in others)),
            None,
        )
        if suite is None:
            sys.exit(f"gate: no suite tells {log_name} apart from {others[0].log_name}")
        alone.append(["--suite", suite, pattern(test)])
        covered.update(t.log_name for t in same if suite in t.suites)
    no_suite = [arg for suite in excluded_suites for arg in ("--no-suite", suite)]
    return [no_suite + argv for argv in ([shared] if shared else []) + alone]


def print_invocations(targets, tests, excluded_suites):
    for argv in invocations(targets, tests, excluded_suites):
        print(" ".join(argv))


mode, tests_path, list_path, suites_path, baseline_path, *rest = sys.argv[1:]
tests = read_tests(Path(tests_path), Path(list_path))
excluded_suites = read_suites(Path(suites_path))
baseline = tomllib.loads(Path(baseline_path).read_text())
must_pass = baseline.get("must_pass", {}).get("tests", [])
excluded = baseline.get("excluded", {})

overlap = sorted(set(must_pass) & set(excluded))
if overlap:
    sys.exit("gate: tests both must_pass and excluded: " + ", ".join(overlap))

if mode == "runnable":
    print_invocations([name for name in tests if name not in excluded], tests, excluded_suites)
    sys.exit(0)

results = read_log(Path(rest[0]))
failing = [name for name in must_pass if results.get(name) not in PASSING]

if mode == "failing":
    # A must_pass test missing from the run (renamed, or the run broke) is
    # not rerun; the report counts it as missing.
    print_invocations(
        [name for name in failing if name in results and name in tests], tests, excluded_suites
    )
    sys.exit(0)

assert mode == "report", mode
out_dir = Path(rest[1])
rerun = read_log(Path(rest[2])) if len(rest) > 2 else {}
flaky = [name for name in failing if rerun.get(name) in PASSING]
failures = [name for name in failing if name not in flaky]

by_result = {}
for name, result in results.items():
    by_result.setdefault(result, []).append(name)

summary = [f"{len(tests)} tests, {len(results)} run"]
summary += [f"{result}: {len(names)}" for result, names in sorted(by_result.items())]
summary.append(f"must_pass: {len(must_pass)}, failing: {len(failures)}")
summary.append(f"flaky: {len(flaky)}")
summary += [
    f"  flaky: {name} ({results.get(name, 'missing')} in the parallel run, {rerun[name]} alone)"
    for name in flaky
]
summary += [
    f"  gating failure: {name} ({results.get(name, 'missing')}"
    + (f", {rerun.get(name, 'missing')} alone" if name in rerun else "")
    + ")"
    for name in failures
]
summary.append(f"excluded, not run: {len(excluded)}")
summary += [f"  not run: {name} ({reason})" for name, reason in sorted(excluded.items())]
summary += [
    f"  warning: excluded test not in the build: {name}"
    for name in excluded
    if name not in tests
]
(out_dir / "summary.txt").write_text("\n".join(summary) + "\n")

proposed = ["# name = result, from this run", "[results]"]
proposed += [f'"{name}" = "{result}"' for name, result in sorted(results.items())]
(out_dir / "proposed-baseline.toml").write_text("\n".join(proposed) + "\n")

print("\n".join(summary))
sys.exit(1 if failures else 0)
