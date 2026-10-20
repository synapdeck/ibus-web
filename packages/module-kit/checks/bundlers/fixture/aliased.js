// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// A module whose engine comes from a path only the application's alias
// resolves.

import { defineModule, transformEngine } from "@ibus-web/module-kit";
import { displayName, transform } from "@fixture/aliased-engine";

export default defineModule({
  name: "aliased-fixture",
  version: "1.0.0",
  license: "MIT OR Apache-2.0",
  engines: { shout: transformEngine({ displayName, languages: ["en"], transform }) },
});
