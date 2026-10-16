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


LIBRARIES = [{"name": "ibus", "version": "1", "count": 1, "symbols": ["ibus_text_new"]}]


class ApiSubsetTest(unittest.TestCase):
    def verify(self, declared, *, subset=True, umbrella=False, outside=(), identity=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "ibus-1.0"
            root.mkdir()
            # A dependency's header, in a directory of its own.
            (Path(directory) / "glib.h").write_text(
                "".join(f"void {name}(void);\n" for name in outside)
            )
            (Path(directory) / "exports.txt").write_text(
                "# IBUSWEB_RUNTIME_ABI 1\n# ibus 1: 1 symbols\n_ibus_text_new\n"
            )
            (Path(directory) / "exports.json").write_text(json.dumps({
                "abi": 1,
                "identity": identity or exports.identity_of(1, LIBRARIES),
                "libraries": LIBRARIES,
            }))
            declarations = "\n".join(f"void {name}(void);" for name in declared)
            (root / "types.h").write_text(declarations)
            (root / "ibus.h").write_text(
                "#include <glib.h>\n"
                + ('#include "types.h"\n' if umbrella else declarations)
            )
            args = SimpleNamespace(
                dir=directory, expect=[], expect_major=[],
                api=[] if subset else [("ibus", "ibus.h")],
                api_subset=[("ibus", "ibus.h")] if subset else [],
                api_hidden=[], api_pkg_config=[], api_side_defined=[],
            )
            with (
                patch.object(exports, "cflags", return_value=[f"-I{root}", f"-I{directory}"]),
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

    def test_subset_rejects_export_declared_outside_the_api_directory(self):
        with self.assertRaisesRegex(SystemExit, "doesn't declare"):
            self.verify(["ibus_bus_new"], umbrella=True, outside=["ibus_text_new"])

    def test_exact_api_still_excludes_included_headers(self):
        with self.assertRaisesRegex(SystemExit, "doesn't declare"):
            self.verify(["ibus_text_new"], subset=False, umbrella=True)

    def test_identity_must_be_its_libraries(self):
        with self.assertRaisesRegex(SystemExit, "isn't its libraries'"):
            self.verify(["ibus_text_new"], identity="0" * 64)


class IdentityTest(unittest.TestCase):
    def test_changes_with_each_library_field_and_the_abi(self):
        base = exports.identity_of(1, LIBRARIES)
        self.assertRegex(base, "^[0-9a-f]{64}$")
        self.assertEqual(base, exports.identity_of(1, [dict(l) for l in LIBRARIES]))
        for changed in (
            exports.identity_of(2, LIBRARIES),
            exports.identity_of(1, [{**LIBRARIES[0], "version": "2"}]),
            exports.identity_of(1, [{**LIBRARIES[0], "name": "other"}]),
            exports.identity_of(1, [{**LIBRARIES[0], "symbols": ["ibus_text_new", "ibus_bus_new"]}]),
        ):
            self.assertNotEqual(base, changed)


if __name__ == "__main__":
    unittest.main()
