// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { KEY, cleanUp, makeTree, own } from "./fixture.ts";
import { globToRegExp, headerLicense, licenseOf, parseReuseToml } from "./reuse.ts";
import { licenseIds } from "./spdx.ts";

afterEach(cleanUp);

test("a single star stops at a slash and a double star doesn't", () => {
  expect(globToRegExp("docs/*.md").test("docs/a.md")).toBe(true);
  expect(globToRegExp("docs/*.md").test("docs/x/a.md")).toBe(false);
  expect(globToRegExp("docs/**").test("docs/x/a.md")).toBe(true);
  expect(globToRegExp("a.b").test("axb")).toBe(false);
  expect(globToRegExp("a\\*b").test("a*b")).toBe(true);
});

test("a header's tags are read without their comment closers", () => {
  expect(headerLicense(`/* ${KEY}: MIT */\n`)).toBe("MIT");
  expect(headerLicense(`<!-- ${KEY}: BSD-3-Clause -->\n`)).toBe("BSD-3-Clause");
  expect(headerLicense(`// ${KEY}: MIT\n// ${KEY}: HPND\n`)).toBe("(MIT) AND (HPND)");
  expect(headerLicense("no tags\n")).toBeUndefined();
});

test("annotations keep their paths, license and precedence", () => {
  const [one, two] = parseReuseToml(`version = 1
[[annotations]]
path = "a/**"
${KEY} = "MIT"

[[annotations]]
path = ["b.txt", "c/*.txt"]
${KEY} = "HPND"
precedence = "override"
`);

  expect(one?.precedence).toBe("closest");
  expect(one?.license).toBe("MIT");
  expect(one?.patterns.some((pattern) => pattern.test("a/x/y.ts"))).toBe(true);
  expect(two?.precedence).toBe("override");
  expect(two?.patterns.some((pattern) => pattern.test("c/d.txt"))).toBe(true);
});

test("a file's license follows REUSE's precedence", async () => {
  const toml = `version = 1
[[annotations]]
path = "closest/**"
${KEY} = "BSD-3-Clause"

[[annotations]]
path = "override/**"
${KEY} = "HPND"
precedence = "override"

[[annotations]]
path = "aggregate/**"
${KEY} = "HPND"
precedence = "aggregate"

[[annotations]]
path = ["last/*", "last/x.ts"]
${KEY} = "MIT"

[[annotations]]
path = "last/x.ts"
${KEY} = "ISC"
`;
  const root = await makeTree({
    "closest/header.ts": own(),
    "closest/bare.ts": "export {};\n",
    "override/header.ts": own(),
    "aggregate/header.ts": own(),
    "last/x.ts": "export {};\n",
    "sidecar/data.bin": "\0binary",
    "sidecar/data.bin.license": `${KEY}: CC0-1.0\n`,
    "none/x.bin": "\0binary",
  });
  const annotations = parseReuseToml(toml);
  const of = (path: string) => licenseOf(root, join(root, path), annotations);

  expect(await of("closest/header.ts")).toBe("MIT OR Apache-2.0");
  expect(await of("closest/bare.ts")).toBe("BSD-3-Clause");
  expect(await of("override/header.ts")).toBe("HPND");
  expect(await of("aggregate/header.ts")).toBe("(MIT OR Apache-2.0) AND (HPND)");
  expect(await of("last/x.ts")).toBe("ISC");
  expect(await of("sidecar/data.bin")).toBe("CC0-1.0");
  expect(await of("none/x.bin")).toBeUndefined();
});

test("an expression's license identifiers, without operators", () => {
  expect(licenseIds("MIT-open-group AND HPND")).toEqual(["HPND", "MIT-open-group"]);
  expect(licenseIds("(MIT OR Apache-2.0) WITH LLVM-exception")).toEqual(["Apache-2.0", "LLVM-exception", "MIT"]);
  expect(licenseIds("(MIT) AND (MIT)")).toEqual(["MIT"]);
});
