# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

# Meson reads cross files in order and later values win, so this one only
# carries what differs from nixpkgs' generated cross file.
mesonFlagsArray+=("--cross-file=@crossFile@")
