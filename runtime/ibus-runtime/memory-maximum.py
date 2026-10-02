# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
"""Sets the maximum of a module's imported shared memory, in place.

A module linked without memory growth declares the memory it imports with
its maximum at its initial size, so an instance accepts only a memory of
exactly that size. Raising the declared maximum lets it accept any size up
to the new one, while the module still has no way to grow what it is given.

The import section is read with Emscripten's own reader."""

import argparse
import sys

PAGE = 65536
LIMITS_SHARED = 0x2


def uleb(value):
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--emscripten", required=True, help="Emscripten's root")
    parser.add_argument("--maximum", required=True, type=int, help="bytes")
    parser.add_argument("module")
    args = parser.parse_args()

    sys.path.insert(0, args.emscripten)
    from tools import webassembly
    from tools.webassembly import ExternType, SecType

    if args.maximum % PAGE != 0:
        sys.exit(f"--maximum {args.maximum} is not a whole number of pages")
    pages = args.maximum // PAGE

    with webassembly.Module(args.module) as module:
        section = module.get_section(SecType.IMPORT)
        if section is None:
            sys.exit(f"{args.module}: no import section")
        # The section's header, its id and then its size, is rebuilt from
        # the size, which a padded encoding of it would put elsewhere.
        size = uleb(section.size)
        header = section.offset - len(size) - 1
        if module.read_at(header, 1 + len(size)) != bytes([SecType.IMPORT]) + size:
            sys.exit(f"{args.module}: the import section's size is padded")
        module.seek(section.offset)
        limits = None
        for _ in range(module.read_uleb()):
            module.read_string()
            module.read_string()
            kind = ExternType(module.read_byte())
            match kind:
                case ExternType.FUNC:
                    module.read_uleb()
                case ExternType.GLOBAL:
                    module.read_sleb()
                    module.read_byte()
                case ExternType.MEMORY:
                    start = module.tell()
                    limits = (start, module.read_limits(), module.tell())
                case ExternType.TABLE:
                    module.read_sleb()
                    module.read_limits()
                case ExternType.TAG:
                    module.read_byte()
                    module.read_uleb()
        if limits is None:
            sys.exit(f"{args.module}: imports no memory")
        start, (flags, initial, _), end = limits
        if not flags & webassembly.LIMITS_HAS_MAX or not flags & LIMITS_SHARED:
            sys.exit(f"{args.module}: its memory isn't shared with a maximum")
        if initial > pages:
            sys.exit(f"{args.module}: its memory starts above {args.maximum} bytes")
        whole = module.read_at(0, module.size)

    replaced = bytes([flags]) + uleb(initial) + uleb(pages)
    body = whole[section.offset : start] + replaced + whole[end : section.offset + section.size]
    out = whole[:header] + bytes([SecType.IMPORT]) + uleb(len(body)) + body
    out += whole[section.offset + section.size :]
    with open(args.module, "wb") as file:
        file.write(out)


if __name__ == "__main__":
    main()
