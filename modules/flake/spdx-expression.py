# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
"""Prints the conjunction of the SPDX expressions given as arguments, each
license once and under its current identifier: GPL-2.0 becomes GPL-2.0-only,
GPL-2.0+ GPL-2.0-or-later. Licenses are never merged on what one permits of
another, so GPL-2.0-only AND GPL-2.0-or-later stays as it is: the expression
says what the contents carry, not what they can be passed on under.

With --summary SUMMARY first, prints SUMMARY instead, a conjunction of
licenses the whole can be passed on under, once every license of the
contents is one of them or one that a GNU GPL among them takes in: a
permissive license, an LGPL whose version it can be converted to, or its own
version's or-later form. Any other license fails."""

import sys

from license_expression import get_spdx_licensing

licensing = get_spdx_licensing()

PERMISSIVE = {
    "BSD-2-Clause",
    "BSD-3-Clause",
    "BSL-1.0",
    "MIT",
    "NAIST-2003",
    "Unicode-DFS-2015",
    "W3C",
    "Zlib",
}

# Apache-2.0 and CC-BY-4.0 are compatible with version 3 of the GPL only.
GPL3_ONLY_PERMISSIVE = {"Apache-2.0", "CC-BY-4.0"}

TAKES = {
    "GPL-2.0-only": {"GPL-2.0-or-later", "LGPL-2.1-only", "LGPL-2.1-or-later"},
    "GPL-2.0-or-later": {"LGPL-2.1-only", "LGPL-2.1-or-later"},
    "GPL-3.0-only": {
        "GPL-2.0-or-later",
        "GPL-3.0-or-later",
        "LGPL-2.1-only",
        "LGPL-2.1-or-later",
        "LGPL-3.0-only",
        "LGPL-3.0-or-later",
    },
    "GPL-3.0-or-later": {
        "GPL-2.0-or-later",
        "LGPL-2.1-only",
        "LGPL-2.1-or-later",
        "LGPL-3.0-only",
        "LGPL-3.0-or-later",
    },
}


def parse(expressions):
    parsed = licensing.parse(" AND ".join(f"({e})" for e in expressions), validate=True, strict=True)
    return licensing.dedup(parsed)


def conjuncts(expression):
    """The licenses of an expression that is a plain conjunction."""
    if isinstance(expression, licensing.AND):
        parts = [part for arg in expression.args for part in conjuncts(arg)]
    elif isinstance(expression, licensing.OR):
        sys.exit(f"{expression.render()}: a choice of licenses can't be summarized")
    else:
        parts = [expression.render()]
    return parts


def takes(summary, license):
    if license == summary:
        return True
    if not summary.startswith("GPL-"):
        return False
    if license in PERMISSIVE:
        return True
    if license in GPL3_ONLY_PERMISSIVE:
        return summary.startswith("GPL-3.0")
    return license in TAKES.get(summary, set())


if sys.argv[1:2] == ["--summary"]:
    summary = parse([sys.argv[2]])
    licenses = conjuncts(summary)
    left = [c for c in conjuncts(parse(sys.argv[3:])) if not any(takes(s, c) for s in licenses)]
    if left:
        sys.exit(f"{summary.render()} doesn't take in {' AND '.join(left)}")
    print(summary.render(), end="")
else:
    print(parse(sys.argv[1:]).render(), end="")
