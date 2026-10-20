// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import module from "./module.js";

// The comment, which a minimizer keeps in a file of its own, is kept in the expression.
export default /*! A legal notice. */ { ...module };
