# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: LGPL-2.1-or-later

"""Writes the tree the installer's test archive holds, the archives it must
refuse, and the listing an installed tree must match.

Usage: make-tree.py TREE OUT

TREE receives the tree, from which the caller builds OUT/tree.tar with GNU
tar; this script writes the refused archives and OUT/listing.txt, and
OUT/corrupt.tar once tree.tar exists (run with --corrupt).
"""

import hashlib
import io
import os
import sys
import tarfile

# Files big enough to span several of the IndexedDB backend's chunks at any
# chunk size it is likely to use (16 to 256 KiB); one of them a whole number
# of tar blocks, the other not. A path longer than ustar's 100-byte name
# field needs its prefix field.
LONG_DIR = "long/" + "d" * 80
FILES = {
    "README": b"Data the installer's tests extract.\n",
    "empty": b"",
    "share/dict/main.dict": 600_001,
    "share/dict/blocks.bin": 131_072,
    "share/dict/deep/er/note.txt": 1_000,
    f"{LONG_DIR}/{'f' * 90}.txt": 5_000,
}
EMPTY_DIRS = ["share/empty"]


def pseudo_random(name, size):
    """Bytes no two files share and no chunk of zeros could pass for, since
    a chunk the backend never wrote reads as zeros."""
    out = bytearray()
    counter = 0
    while len(out) < size:
        out += hashlib.sha256(f"{name}:{counter}".encode()).digest()
        counter += 1
    return bytes(out[:size])


def write_tree(root):
    for name, contents in FILES.items():
        path = os.path.join(root, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        data = contents if isinstance(contents, bytes) else pseudo_random(name, contents)
        with open(path, "wb") as f:
            f.write(data)
    for name in EMPTY_DIRS:
        os.makedirs(os.path.join(root, name), exist_ok=True)


def listing(root):
    """One line per entry, `PATH\\td` or `PATH\\tf SIZE SHA256`, sorted
    bytewise, so that a parent sorts before its children."""
    lines = []
    for dirpath, dirnames, filenames in os.walk(root):
        rel = os.path.relpath(dirpath, root)
        for name in dirnames:
            lines.append(f"{os.path.normpath(os.path.join(rel, name))}\td")
        for name in filenames:
            with open(os.path.join(dirpath, name), "rb") as f:
                data = f.read()
            path = os.path.normpath(os.path.join(rel, name))
            lines.append(f"{path}\tf {len(data)} {hashlib.sha256(data).hexdigest()}")
    lines.sort(key=lambda line: line.encode())
    return "".join(f"{line}\n" for line in lines)


def member(name, kind=tarfile.REGTYPE, data=b"", linkname=""):
    info = tarfile.TarInfo(name)
    info.type = kind
    info.size = len(data) if kind == tarfile.REGTYPE else 0
    info.linkname = linkname
    info.mode = 0o755 if kind == tarfile.DIRTYPE else 0o644
    info.mtime = 0
    return info, (io.BytesIO(data) if kind == tarfile.REGTYPE else None)


def refused(path, bad):
    """An archive with a file the installer accepts, then one member it must
    refuse."""
    with tarfile.open(path, "w", format=tarfile.USTAR_FORMAT) as tar:
        tar.addfile(*member("ok.txt", data=b"accepted\n"))
        tar.addfile(*bad)


def write_refused(out):
    refused(f"{out}/absolute.tar", member("/ibus-web-escape.txt", data=b"escaped\n"))
    refused(f"{out}/dotdot.tar", member("sub/../../ibus-web-escape.txt", data=b"escaped\n"))
    refused(f"{out}/symlink.tar", member("link", tarfile.SYMTYPE, linkname="/"))
    refused(f"{out}/hardlink.tar", member("hard", tarfile.LNKTYPE, linkname="ok.txt"))
    refused(f"{out}/fifo.tar", member("fifo", tarfile.FIFOTYPE))


def write_corrupt(out):
    """tree.tar with one byte of its second header's name changed, which its
    checksum no longer matches."""
    with open(f"{out}/tree.tar", "rb") as f:
        data = bytearray(f.read())
    first_size = int(data[124:136].rstrip(b"\0 ") or b"0", 8)
    second = 512 + (first_size + 511) // 512 * 512
    data[second] ^= 0x01
    with open(f"{out}/corrupt.tar", "wb") as f:
        f.write(data)


if __name__ == "__main__":
    if sys.argv[1] == "--corrupt":
        write_corrupt(sys.argv[2])
    else:
        tree, out = sys.argv[1:3]
        write_tree(tree)
        os.makedirs(out, exist_ok=True)
        with open(f"{out}/listing.txt", "w") as f:
            f.write(listing(tree))
        write_refused(out)
