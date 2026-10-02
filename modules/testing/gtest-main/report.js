// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// How a GoogleTest program hands its report to the test-program shim. The
// call is proxied to the program's main thread: in a browser that is the
// Worker the shim started, whose messages go to the page; under Node, the
// shim reads the file it names in IBUS_WEB_TEST_REPORT.

/**
 * @param {number} text a pointer to the report's UTF-8 text
 * @param {number} length its length in bytes
 */
const ibus_web_test_report = (text, length) => {
  const report = UTF8ToString(text, length);
  if (ENVIRONMENT_IS_NODE) {
    const path = process.env["IBUS_WEB_TEST_REPORT"];
    if (path === undefined) err("ibus_web_test_report: IBUS_WEB_TEST_REPORT is not set");
    else process.getBuiltinModule("node:fs").writeFileSync(path, report);
  } else {
    postMessage({ kind: "report", format: "gtest-json", text: report });
  }
};

addToLibrary({
  ibus_web_test_report__deps: ["$UTF8ToString"],
  ibus_web_test_report__proxy: "sync",
  ibus_web_test_report__sig: "vpp",
  ibus_web_test_report: ibus_web_test_report,
});
