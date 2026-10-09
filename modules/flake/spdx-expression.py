# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
"""Prints the conjunction of the SPDX expressions given as arguments, each
license once and under its current identifier: GPL-2.0 becomes GPL-2.0-only,
GPL-2.0+ GPL-2.0-or-later. Licenses are never merged on what one permits of
another, so GPL-2.0-only AND GPL-2.0-or-later stays as it is: the expression
says what the contents carry, not what they can be passed on under."""

import sys

from license_expression import get_spdx_licensing

licensing = get_spdx_licensing()
parsed = licensing.parse(" AND ".join(f"({arg})" for arg in sys.argv[1:]), validate=True, strict=True)
print(licensing.dedup(parsed).render(), end="")
