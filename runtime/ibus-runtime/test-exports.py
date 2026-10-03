# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("exports", Path(__file__).with_name("exports.py"))
exports = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exports)


class ApiSubsetTest(unittest.TestCase):
    def verify(self, declared, *, subset=True, umbrella=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "exports.txt").write_text(
                "# IBUSWEB_RUNTIME_ABI 1\n# ibus 1: 1 symbols\n_ibus_text_new\n"
            )
            (root / "exports.json").write_text(json.dumps({
                "abi": 1,
                "libraries": [{
                    "name": "ibus", "version": "1", "count": 1,
                    "symbols": ["ibus_text_new"],
                }],
            }))
            declarations = "\n".join(f"void {name}(void);" for name in declared)
            (root / "types.h").write_text(declarations)
            (root / "ibus.h").write_text(
                '#include "types.h"\n' if umbrella else declarations
            )
            args = SimpleNamespace(
                dir=directory, expect=[], expect_major=[],
                api=[] if subset else [("ibus", "ibus.h")],
                api_subset=[("ibus", "ibus.h")] if subset else [],
                api_hidden=[], api_pkg_config=[], api_side_defined=[],
            )
            with (
                patch.object(exports, "cflags", return_value=[f"-I{directory}"]),
                contextlib.redirect_stdout(io.StringIO()),
            ):
                exports.verify(args)

    def test_subset_allows_unimplemented_declarations(self):
        self.verify(["ibus_text_new", "ibus_bus_new"])

    def test_subset_rejects_undeclared_export(self):
        with self.assertRaisesRegex(SystemExit, "doesn't declare"):
            self.verify(["ibus_bus_new"])

    def test_exact_api_still_requires_all_declarations(self):
        with self.assertRaisesRegex(SystemExit, "doesn't export"):
            self.verify(["ibus_text_new", "ibus_bus_new"], subset=False)

    def test_subset_accepts_umbrella_header(self):
        self.verify(["ibus_text_new", "ibus_bus_new"], umbrella=True)

    def test_exact_api_still_excludes_included_headers(self):
        with self.assertRaisesRegex(SystemExit, "doesn't declare"):
            self.verify(["ibus_text_new"], subset=False, umbrella=True)


if __name__ == "__main__":
    unittest.main()
