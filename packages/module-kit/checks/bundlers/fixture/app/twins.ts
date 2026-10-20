// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// An application importing two entries that build modules of the same name.

import fixture from "../module.js?ibus-module";
import twin from "../twin.js?ibus-module";

Object.assign(globalThis, { modules: { fixture, twin } });
