// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// An application importing two modules from its own build, which leaves their
// manifests' URLs where the check reads them.

import aliased from "../aliased.js?ibus-module";
import fixture from "../module.js?ibus-module";

Object.assign(globalThis, { modules: { fixture, aliased } });
