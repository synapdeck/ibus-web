# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
"""Exercise the gate's test selection against Meson itself.

    gate-test.py GATE SETUP_EXCLUDES

Sets up a small Meson project whose tests collide in the ways the gate has
to tell apart, runs the invocations the gate prints with `meson test`, and
checks that exactly the intended tests ran. Inputs Meson can't produce
(names with whitespace) are written by hand.
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

GATE, SETUP_EXCLUDES = sys.argv[1:]

# Two `x` tests, one without a suite (its only suite is the bare project),
# and three `y` tests, one of them in a suite the default setup excludes.
MESON_BUILD = """
project('gate')
add_test_setup('default', is_default: true, exclude_suites: ['flaky'])
true_prog = find_program('true')
test('x', true_prog)
test('x', true_prog, suite: 'a')
test('y', true_prog, suite: 'b')
test('y', true_prog, suite: ['b', 'flaky'])
test('y', true_prog, suite: 'c')
"""


def run(*argv, cwd, check=True):
    return subprocess.run(argv, cwd=cwd, check=check, capture_output=True, text=True)


def gate(build, mode, excluded, *rest, must_pass=()):
    baseline = build / "baseline.toml"
    lines = ["[must_pass]", f"tests = {json.dumps(list(must_pass))}", "[excluded]"]
    lines += [f"{json.dumps(name)} = \"synthetic\"" for name in excluded]
    baseline.write_text("\n".join(lines) + "\n")
    return run(
        sys.executable,
        GATE,
        mode,
        "meson-info/intro-tests.json",
        "default-tests",
        "excluded-suites",
        str(baseline),
        *rest,
        cwd=build,
        check=False,
    )


def ran(build, invocations):
    """Log names of the tests that `meson test` runs for each invocation."""
    names = []
    for n, line in enumerate(invocations.splitlines()):
        base = f"sel-{n}"
        run("meson", "test", "--no-rebuild", "--logbase", base, *line.split(), cwd=build)
        log = (build / "meson-logs" / f"{base}.json").read_text()
        names += [json.loads(entry)["name"] for entry in log.splitlines() if entry.strip()]
    return names


def expect(label, actual, wanted):
    if actual != wanted:
        sys.exit(f"{label}: got {actual!r}, wanted {wanted!r}")
    print(f"ok: {label}")


def expect_failure(label, result, message):
    if result.returncode == 0 or message not in result.stderr:
        sys.exit(f"{label}: exit {result.returncode}, stderr {result.stderr!r}")
    print(f"ok: {label}: {result.stderr.strip()}")


with tempfile.TemporaryDirectory() as tmp:
    source = Path(tmp) / "source"
    build = Path(tmp) / "build"
    source.mkdir()
    (source / "meson.build").write_text(MESON_BUILD)
    run("meson", "setup", str(build), str(source), cwd=tmp)
    listed = run("meson", "test", "--no-rebuild", "--list", cwd=build).stdout
    (build / "default-tests").write_text(listed)
    suites = run("meson", "runpython", SETUP_EXCLUDES, cwd=build).stdout
    (build / "excluded-suites").write_text(suites)

    expect("excluded suites from the default setup", suites.split(), ["flaky"])
    expect(
        "the listed tests",
        sorted(listed.splitlines()),
        ["a - gate:x", "b - gate:y", "c - gate:y", "gate:x"],
    )
    # What the gate guards against: --suite brings back the excluded test.
    expect(
        "--suite overrides the setup's exclusion",
        sorted(ran(build, "--suite gate:b gate:y")),
        ["b - gate:y", "b+flaky - gate:y"],
    )

    # `a - gate:x` is told apart by its own suite, and `b - gate:y` by `b`,
    # which the excluded `b+flaky - gate:y` shares.
    result = gate(build, "runnable", ["gate:x", "c - gate:y"])
    expect("runnable exits 0", (result.returncode, result.stderr), (0, ""))
    expect(
        "every invocation excludes the setup's suites",
        [line.split()[:2] for line in result.stdout.splitlines()],
        [["--no-suite", "flaky"]] * 2,
    )
    expect("runnable selection", sorted(ran(build, result.stdout)), ["a - gate:x", "b - gate:y"])

    # The bare `gate:x` shares every suite but the bare project's, which
    # would select both `x` tests, so the gate refuses instead.
    expect_failure(
        "a bare project suite never narrows",
        gate(build, "runnable", ["a - gate:x"]),
        "no suite tells gate:x apart",
    )

    # A rerun of a failed must_pass test narrows the same way.
    testlog = build / "testlog.json"
    testlog.write_text(json.dumps({"name": "b - gate:y", "result": "FAIL"}) + "\n")
    result = gate(
        build, "failing", ["c - gate:y"], str(testlog), must_pass=["b - gate:y"]
    )
    expect("failing exits 0", (result.returncode, result.stderr), (0, ""))
    expect("rerun selection", ran(build, result.stdout), ["b - gate:y"])

    # Meson accepts a test name with a space; a project name's spaces
    # become underscores in its suites, which the gate reads it from.
    for label, entry, log_name in [
        ("test name", {"name": "has space", "suite": ["gate"]}, "gate:has space"),
        ("project name", {"name": "t", "suite": ["my project:s"]}, "s - my project:t"),
    ]:
        (build / "meson-info" / "intro-tests.json").write_text(json.dumps([entry]))
        (build / "default-tests").write_text(log_name + "\n")
        expect_failure(
            f"whitespace in a {label}",
            gate(build, "runnable", []),
            "contains whitespace",
        )
    (build / "meson-info" / "intro-tests.json").write_text("[]")
    (build / "default-tests").write_text("")
    (build / "excluded-suites").write_text("two words\n")
    expect_failure(
        "whitespace in an excluded suite",
        gate(build, "runnable", []),
        "contains whitespace",
    )
