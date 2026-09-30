# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
"""Compare a Meson test log with the committed baseline.

Only tests listed under must_pass gate the build; excluded tests carry the
reason they cannot run here, and every other result is reported but
informational.
"""

import json
import sys
from pathlib import Path

import tomllib

testlog, baseline_path, out_dir = map(Path, sys.argv[1:4])

results = {}
for line in testlog.read_text().splitlines():
    if line.strip():
        entry = json.loads(line)
        results[entry["name"]] = entry["result"]

baseline = tomllib.loads(baseline_path.read_text())
must_pass = baseline.get("must_pass", {}).get("tests", [])
excluded = baseline.get("excluded", {})

failures = [
    name for name in must_pass if results.get(name) not in ("OK", "EXPECTEDFAIL")
]

by_result = {}
for name, result in results.items():
    by_result.setdefault(result, []).append(name)

summary = [f"{len(results)} tests"]
summary += [f"{result}: {len(names)}" for result, names in sorted(by_result.items())]
summary.append(f"must_pass: {len(must_pass)}, failing: {len(failures)}")
summary += [
    f"  gating failure: {name} ({results.get(name, 'missing')})" for name in failures
]
(out_dir / "summary.txt").write_text("\n".join(summary) + "\n")

proposed = ["# name = result, from this run", "[results]"]
proposed += [f'"{name}" = "{result}"' for name, result in sorted(results.items())]
(out_dir / "proposed-baseline.toml").write_text("\n".join(proposed) + "\n")

print("\n".join(summary))
sys.exit(1 if failures else 0)
