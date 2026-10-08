// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

#pragma once

#include <cstdint>

// X11 keysyms and IBus modifier masks by value, so that sessions build
// without IBus headers.
namespace ibusweb::table::keys {

inline constexpr std::uint32_t space = 0x20;
inline constexpr std::uint32_t BackSpace = 0xff08;
inline constexpr std::uint32_t Tab = 0xff09;
inline constexpr std::uint32_t Return = 0xff0d;
inline constexpr std::uint32_t Escape = 0xff1b;
inline constexpr std::uint32_t Home = 0xff50;
inline constexpr std::uint32_t Left = 0xff51;
inline constexpr std::uint32_t Up = 0xff52;
inline constexpr std::uint32_t Right = 0xff53;
inline constexpr std::uint32_t Down = 0xff54;
inline constexpr std::uint32_t Page_Up = 0xff55;
inline constexpr std::uint32_t Page_Down = 0xff56;
inline constexpr std::uint32_t End = 0xff57;
inline constexpr std::uint32_t KP_Enter = 0xff8d;
inline constexpr std::uint32_t ISO_Left_Tab = 0xfe20;

// Pressing a modifier on its own arrives as a key event too. Treating it as
// "any other key" would flush a continuous composition between `_` and a
// shifted `H`.
constexpr bool isModifier(std::uint32_t keyval) {
  const bool shiftToHyper = keyval >= 0xffe1 && keyval <= 0xffee;
  const bool isoLocksAndGroups = keyval >= 0xfe01 && keyval <= 0xfe0f;
  const bool modeSwitchAndNumLock = keyval == 0xff7e || keyval == 0xff7f;
  return shiftToHyper || isoLocksAndGroups || modeSwitchAndNumLock;
}

} // namespace ibusweb::table::keys

namespace ibusweb::table::masks {

inline constexpr std::uint32_t Shift = 1u << 0;
inline constexpr std::uint32_t Control = 1u << 2;
inline constexpr std::uint32_t Mod1 = 1u << 3;
inline constexpr std::uint32_t Super = 1u << 26;
inline constexpr std::uint32_t Release = 1u << 30;

} // namespace ibusweb::table::masks
