// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { spike } from "../shared/spike.ts";

export const describe = (doc: Document): string =>
  `${spike} in the page ${doc.title}`;
