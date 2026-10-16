// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, it } from "vitest";
import { releaseNotes, section } from "./notes.ts";

const facade = {
  name: "ibus-web",
  text: [
    "# ibus-web",
    "",
    "## 1.1.0",
    "",
    "### Minor Changes",
    "",
    "- Preloading.",
    "",
    "## 1.0.0",
    "",
    "### Major Changes",
    "",
    "- The first release.",
    "",
  ].join("\n"),
};

const engine = {
  name: "@ibus-web/engine-hangul",
  text: [
    "# @ibus-web/engine-hangul",
    "",
    "## 1.1.0",
    "",
    "No changes in this release.",
    "",
    "## 1.0.0",
    "",
    "### Major Changes",
    "",
    "- Hangul.",
    "",
  ].join("\n"),
};

const core = {
  name: "@ibus-web/core",
  text: [
    "# @ibus-web/core",
    "",
    "## 1.1.0",
    "",
    "### Patch Changes",
    "",
    "- Updated dependencies []:",
    "  - @ibus-web/protocol@1.1.0",
    "  - @ibus-web/worker-host@1.1.0",
    "",
  ].join("\n"),
};

const panel = {
  name: "@ibus-web/panel",
  text: [
    "# @ibus-web/panel",
    "",
    "## 1.1.0",
    "",
    "### Minor Changes",
    "",
    "- [`48d9e90`](https://github.com/synapdeck/ibus-web/commit/48d9e90) Thanks [@typedrat](https://github.com/typedrat)! - Vertical candidates.",
    "",
    "### Patch Changes",
    "",
    "- Updated dependencies [[`48d9e90`](https://github.com/synapdeck/ibus-web/commit/48d9e90)]:",
    "  - @ibus-web/core@1.1.0",
    "",
  ].join("\n"),
};

describe("section", () => {
  it("takes the lines under the version's heading, up to the next version", () => {
    expect(section(facade, "1.1.0")).toBe("### Minor Changes\n\n- Preloading.");
  });

  it("takes the last section to the end of the file", () => {
    expect(section(facade, "1.0.0")).toBe("### Major Changes\n\n- The first release.");
  });

  it("refuses a changelog without the version", () => {
    expect(() => section(facade, "2.0.0")).toThrow("ibus-web: its changelog has no section for 2.0.0");
  });

  it("doesn't take a version that only starts the heading", () => {
    expect(() => section(facade, "1.1")).toThrow("no section for 1.1");
  });
});

describe("releaseNotes", () => {
  it("lists each package's changes under its name, in the order given", () => {
    expect(releaseNotes("1.0.0", [facade, engine])).toBe(
      [
        "# 1.0.0",
        "",
        "## ibus-web",
        "",
        "### Major Changes",
        "",
        "- The first release.",
        "",
        "## @ibus-web/engine-hangul",
        "",
        "### Major Changes",
        "",
        "- Hangul.",
        "",
      ].join("\n"),
    );
  });

  it("leaves out a package bumped without changes", () => {
    expect(releaseNotes("1.1.0", [facade, engine])).toBe(
      "# 1.1.0\n\n## ibus-web\n\n### Minor Changes\n\n- Preloading.\n",
    );
  });

  it("leaves out a package bumped only because its dependencies were", () => {
    expect(releaseNotes("1.1.0", [facade, core])).toBe(
      "# 1.1.0\n\n## ibus-web\n\n### Minor Changes\n\n- Preloading.\n",
    );
  });

  it("leaves out dependency updates, and a heading they leave empty, from a changed package", () => {
    expect(releaseNotes("1.1.0", [panel])).toBe(
      [
        "# 1.1.0",
        "",
        "## @ibus-web/panel",
        "",
        "### Minor Changes",
        "",
        "- [`48d9e90`](https://github.com/synapdeck/ibus-web/commit/48d9e90) Thanks [@typedrat](https://github.com/typedrat)! - Vertical candidates.",
        "",
      ].join("\n"),
    );
  });

  it("recognizes the plain changelog's dependency list", () => {
    const plain = {
      name: "@ibus-web/core",
      text: "## 1.1.0\n\n### Patch Changes\n\n- @ibus-web/protocol@1.1.0\n  - @ibus-web/worker-host@1.1.0\n",
    };
    expect(() => releaseNotes("1.1.0", [plain])).toThrow("no package changed in 1.1.0");
  });

  it("keeps a change that mentions a dependency", () => {
    const fix = {
      name: "@ibus-web/core",
      text: "## 1.1.0\n\n### Patch Changes\n\n- abc1234: Requires @ibus-web/protocol@1.1.0 for the new request.\n",
    };
    expect(releaseNotes("1.1.0", [fix])).toContain("Requires @ibus-web/protocol@1.1.0");
  });

  it("refuses a release in which nothing changed", () => {
    expect(() => releaseNotes("1.1.0", [engine])).toThrow("no package changed in 1.1.0");
  });
});
