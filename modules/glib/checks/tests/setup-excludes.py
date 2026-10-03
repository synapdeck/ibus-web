# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
"""Print the suites the default test setup excludes, one per line.

Meson introspection doesn't describe test setups, so this reads Meson's
own build data: run it with `meson runpython` in a build directory. The
data is a pickle of Meson's own Python objects, which only Meson's Python
can load, so this is Python.
"""

from mesonbuild import build

data = build.load(".")
if data.test_setup_default_name is not None:
    for suite in data.test_setups[data.test_setup_default_name].exclude_suites:
        print(suite)
