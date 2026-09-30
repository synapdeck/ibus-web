# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
"""Compare a Meson test log with the committed baseline.

Only tests listed under must_pass gate the build; excluded tests carry the
reason they cannot run here, and every other result is reported but
informational.

With --failing, print the must_pass tests that did not pass, as `meson test`
arguments, so they can be rerun alone. Given a second log from that rerun, a
test that passes there counts as passed but is reported as flaky: under the
parallel run's load, tests that assert wall-clock bounds miss them.
"""

import json
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


def meson_name(name):
    # Log names are "<suites> - <project>:<test>"; meson test takes the part
    # after the suites.
    return name.split(" - ", 1)[-1]


args = sys.argv[1:]
list_failing = args[:1] == ["--failing"]
if list_failing:
    args = args[1:]

testlog, baseline_path = map(Path, args[:2])
results = read_log(testlog)
baseline = tomllib.loads(baseline_path.read_text())
must_pass = baseline.get("must_pass", {}).get("tests", [])
excluded = baseline.get("excluded", {})

failing = [name for name in must_pass if results.get(name) not in PASSING]

if list_failing:
    for name in failing:
        print(meson_name(name))
    sys.exit(0)

out_dir = Path(args[2])
rerun = read_log(Path(args[3])) if len(args) > 3 else {}
flaky = [name for name in failing if rerun.get(name) in PASSING]
failures = [name for name in failing if name not in flaky]

by_result = {}
for name, result in results.items():
    by_result.setdefault(result, []).append(name)

summary = [f"{len(results)} tests"]
summary += [f"{result}: {len(names)}" for result, names in sorted(by_result.items())]
summary.append(f"must_pass: {len(must_pass)}, failing: {len(failures)}")
summary.append(f"flaky: {len(flaky)}")
summary += [
    f"  flaky: {name} ({results[name]} in the parallel run, {rerun[name]} alone)"
    for name in flaky
]
summary += [
    f"  gating failure: {name} ({results.get(name, 'missing')}"
    + (f", {rerun.get(name, 'missing')} alone" if name in rerun else "")
    + ")"
    for name in failures
]
(out_dir / "summary.txt").write_text("\n".join(summary) + "\n")

proposed = ["# name = result, from this run", "[results]"]
proposed += [f'"{name}" = "{result}"' for name, result in sorted(results.items())]
(out_dir / "proposed-baseline.toml").write_text("\n".join(proposed) + "\n")

print("\n".join(summary))
sys.exit(1 if failures else 0)
