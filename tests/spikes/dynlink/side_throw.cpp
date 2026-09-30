// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

#include <stdexcept>

extern "C" int probe() { throw std::runtime_error("thrown in side module"); }
