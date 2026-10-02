// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// A WasmFS backend storing files in IndexedDB. Every operation is proxied to
// the backend's own thread, whose event loop IndexedDB's callbacks need, and
// blocks its caller until the transaction behind it has completed.

#include <ibus-web/wasmfs-idb.h>

#include <atomic>
#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <memory>
#include <string>
#include <vector>

#include <emscripten/console.h>
#include <emscripten/threading.h>

#include "backend.h"
#include "file.h"
#include "idb_backend.h"
#include "thread_utils.h"
#include "wasmfs.h"

namespace {

using emscripten::ProxyWorker;
using wasmfs::DataFile;
using wasmfs::Directory;
using wasmfs::File;
using wasmfs::oflags_t;
using wasmfs::Symlink;

// Chunk size for databases this backend creates; a database keeps the size it
// was created with.
constexpr uint32_t defaultChunkSize = 64 * 1024;

// Every offset a file may reach is a double holding an integer exactly.
constexpr off_t maxFileSize = (off_t(1) << 53) - 1;

class IdbBackend : public wasmfs::Backend {
public:
  ProxyWorker proxy;
  // Set from the start, or by sealing; read on every caller's thread.
  std::atomic<bool> readOnly;
  // Read-only from the start, so nothing it wrote needs making durable.
  const bool openedReadOnly;
  // The JavaScript side's handle for this backend's state; 0 until opened.
  int id = 0;
  uint32_t root = 0;
  // Set from the backend's thread when the database closes; every call after
  // that fails with EIO.
  std::atomic<int32_t> closed{0};
  // JavaScript sets it with Atomics.store on the bare int32.
  static_assert(sizeof(closed) == sizeof(int32_t));
  static_assert(std::atomic<int32_t>::is_always_lock_free);

  explicit IdbBackend(bool readOnly)
      : readOnly(readOnly), openedReadOnly(readOnly) {}

  // A file can't exist outside a directory in the database.
  std::shared_ptr<DataFile> createFile(mode_t mode) override { return nullptr; }

  // Mounting the backend asks for its root, which the database already has,
  // with its stored mode and times rather than the mount's mode.
  std::shared_ptr<Directory> createDirectory(mode_t mode) override;

  std::shared_ptr<Symlink> createSymlink(std::string target) override {
    return nullptr;
  }

  int setMode(uint32_t ino, mode_t mode) {
    if (readOnly) {
      return -EROFS;
    }
    int err = 0;
    proxy([&](auto ctx) {
      _wasmfs_idb_set_mode(ctx.ctx, id, ino, mode & 07777, &err);
    });
    return err;
  }

  int setTimes(uint32_t ino, double atime, double mtime) {
    if (readOnly) {
      return -EROFS;
    }
    int err = 0;
    proxy([&](auto ctx) {
      _wasmfs_idb_set_times(ctx.ctx, id, ino, atime, mtime, &err);
    });
    return err;
  }
};

// Each file's constructor replaces the times File's made up with the stored
// ones.
class IdbFile : public DataFile {
public:
  IdbBackend &backend;
  const uint32_t ino;

  IdbFile(IdbBackend &backend, const IdbAttrs &attrs)
      : DataFile(attrs.mode, &backend), backend(backend), ino(attrs.ino) {
    atime = attrs.atime;
    mtime = attrs.mtime;
    ctime = attrs.ctime;
  }

private:
  int open(oflags_t flags) override {
    if (backend.readOnly && flags != O_RDONLY) {
      return -EROFS;
    }
    int err = 0;
    backend.proxy([&](auto ctx) {
      _wasmfs_idb_open_file(ctx.ctx, backend.id, ino, &err);
    });
    return err;
  }

  int close() override {
    int err = 0;
    backend.proxy([&](auto ctx) {
      _wasmfs_idb_close_file(ctx.ctx, backend.id, ino, &err);
    });
    return err;
  }

  ssize_t read(uint8_t *buf, size_t len, off_t offset) override {
    if (offset < 0) {
      return -EINVAL;
    }
    int32_t nread = 0;
    backend.proxy([&](auto ctx) {
      _wasmfs_idb_read(ctx.ctx, backend.id, ino, buf, len, offset, &nread);
    });
    return nread;
  }

  ssize_t write(const uint8_t *buf, size_t len, off_t offset) override {
    if (backend.readOnly) {
      return -EROFS;
    }
    if (offset < 0) {
      return -EINVAL;
    }
    if (offset > maxFileSize || off_t(len) > maxFileSize - offset) {
      return -EFBIG;
    }
    int32_t nwritten = 0;
    backend.proxy([&](auto ctx) {
      _wasmfs_idb_write(ctx.ctx, backend.id, ino, buf, len, offset, &nwritten);
    });
    return nwritten;
  }

  // WasmFS takes a negative size as an errno and fails the call with it.
  off_t getSize() override {
    double size = 0;
    int err = 0;
    backend.proxy([&](auto ctx) {
      _wasmfs_idb_get_size(ctx.ctx, backend.id, ino, &size, &err);
    });
    return err ? off_t(err) : off_t(size);
  }

  int setSize(off_t size) override {
    if (backend.readOnly) {
      return -EROFS;
    }
    if (size > maxFileSize) {
      return -EFBIG;
    }
    int err = 0;
    backend.proxy([&](auto ctx) {
      _wasmfs_idb_set_size(ctx.ctx, backend.id, ino, size, &err);
    });
    return err;
  }

  // A backend read-only from the start has written nothing to make durable;
  // a sealed one may have.
  int flush() override {
    if (backend.openedReadOnly) {
      return 0;
    }
    int err = 0;
    backend.proxy(
        [&](auto ctx) { _wasmfs_idb_flush(ctx.ctx, backend.id, &err); });
    return err;
  }

  int setMode(mode_t mode) override { return backend.setMode(ino, mode); }

  int setTimes(double atime, double mtime) override {
    return backend.setTimes(ino, atime, mtime);
  }
};

class IdbSymlink : public Symlink {
public:
  IdbBackend &backend;
  const uint32_t ino;
  const std::string target;

  IdbSymlink(IdbBackend &backend, const IdbAttrs &attrs, std::string target)
      : Symlink(&backend), backend(backend), ino(attrs.ino),
        target(std::move(target)) {
    atime = attrs.atime;
    mtime = attrs.mtime;
    ctime = attrs.ctime;
  }

  std::string getTarget() const override { return target; }

private:
  int setMode(mode_t mode) override { return backend.setMode(ino, mode); }

  int setTimes(double atime, double mtime) override {
    return backend.setTimes(ino, atime, mtime);
  }
};

class IdbDirectory : public Directory {
public:
  IdbBackend &backend;
  const uint32_t ino;

  IdbDirectory(IdbBackend &backend, const IdbAttrs &attrs)
      : Directory(attrs.mode, &backend), backend(backend), ino(attrs.ino) {
    atime = attrs.atime;
    mtime = attrs.mtime;
    ctime = attrs.ctime;
  }

private:
  std::shared_ptr<File> makeFile(const IdbAttrs &attrs, std::string target) {
    switch (attrs.kind) {
    case File::DataFileKind:
      return std::make_shared<IdbFile>(backend, attrs);
    case File::DirectoryKind:
      return std::make_shared<IdbDirectory>(backend, attrs);
    case File::SymlinkKind:
      return std::make_shared<IdbSymlink>(backend, attrs, std::move(target));
    default:
      return nullptr;
    }
  }

  // The inode a file of this backend stands for.
  static uint32_t inoOf(File &file) {
    switch (file.kind) {
    case File::DataFileKind:
      return static_cast<IdbFile &>(file).ino;
    case File::DirectoryKind:
      return static_cast<IdbDirectory &>(file).ino;
    case File::SymlinkKind:
      return static_cast<IdbSymlink &>(file).ino;
    default:
      WASMFS_UNREACHABLE("Unexpected file kind");
    }
  }

  std::shared_ptr<File> getChild(const std::string &name) override {
    IdbAttrs attrs{};
    std::string target;
    backend.proxy([&](auto ctx) {
      _wasmfs_idb_get_child(ctx.ctx, backend.id, ino, name.c_str(), &attrs,
                            &target);
    });
    if (attrs.err) {
      // WasmFS reads null as ENOENT, so any other failure, such as a closed
      // database, would pass unseen.
      if (attrs.err != -ENOENT) {
        emscripten_errf("wasmfs-idb: looking up %s failed: %s", name.c_str(),
                        strerror(-attrs.err));
      }
      return nullptr;
    }
    return makeFile(attrs, std::move(target));
  }

  IdbAttrs insert(const std::string &name, File::FileKind kind, mode_t mode,
                  const char *target) {
    IdbAttrs attrs{};
    if (backend.readOnly) {
      attrs.err = -EROFS;
      return attrs;
    }
    backend.proxy([&](auto ctx) {
      _wasmfs_idb_insert(ctx.ctx, backend.id, ino, name.c_str(), kind,
                         mode & 07777, target, &attrs);
    });
    return attrs;
  }

  MaybeFile<DataFile> insertDataFile(const std::string &name,
                                     mode_t mode) override {
    auto attrs = insert(name, File::DataFileKind, mode, nullptr);
    if (attrs.err) {
      return attrs.err;
    }
    return std::make_shared<IdbFile>(backend, attrs);
  }

  MaybeFile<Directory> insertDirectory(const std::string &name,
                                       mode_t mode) override {
    auto attrs = insert(name, File::DirectoryKind, mode, nullptr);
    if (attrs.err) {
      return attrs.err;
    }
    return std::make_shared<IdbDirectory>(backend, attrs);
  }

  MaybeFile<Symlink> insertSymlink(const std::string &name,
                                   const std::string &target) override {
    auto attrs = insert(name, File::SymlinkKind, 0777, target.c_str());
    if (attrs.err) {
      return attrs.err;
    }
    return std::make_shared<IdbSymlink>(backend, attrs, target);
  }

  int insertMove(const std::string &name, std::shared_ptr<File> file) override {
    if (file->getBackend() != &backend) {
      return -EBUSY;
    }
    if (backend.readOnly) {
      return -EROFS;
    }
    // The database finds an entry by its parent and name, which only the
    // directory cache knows. The caller holds both parents' locks, which
    // are recursive.
    auto oldParent = file->locked().getParent();
    if (!oldParent) {
      return -ENOENT;
    }
    auto oldName = oldParent->locked().getName(file);
    if (oldName.empty()) {
      return -ENOENT;
    }
    auto oldParentIno = inoOf(*oldParent);
    int err = 0;
    backend.proxy([&](auto ctx) {
      _wasmfs_idb_move(ctx.ctx, backend.id, inoOf(*file), oldParentIno,
                       oldName.c_str(), ino, name.c_str(), &err);
    });
    return err;
  }

  int removeChild(const std::string &name) override {
    if (backend.readOnly) {
      return -EROFS;
    }
    int err = 0;
    backend.proxy([&](auto ctx) {
      _wasmfs_idb_remove(ctx.ctx, backend.id, ino, name.c_str(), &err);
    });
    return err;
  }

  ssize_t getNumEntries() override {
    int32_t count = 0;
    backend.proxy([&](auto ctx) {
      _wasmfs_idb_count_entries(ctx.ctx, backend.id, ino, &count);
    });
    return count;
  }

  MaybeEntries getEntries() override {
    std::vector<Directory::Entry> entries;
    int err = 0;
    backend.proxy([&](auto ctx) {
      _wasmfs_idb_get_entries(ctx.ctx, backend.id, ino, &entries, &err);
    });
    if (err) {
      return {err};
    }
    return {entries};
  }

  int setMode(mode_t mode) override { return backend.setMode(ino, mode); }

  int setTimes(double atime, double mtime) override {
    return backend.setTimes(ino, atime, mtime);
  }
};

std::shared_ptr<Directory> IdbBackend::createDirectory(mode_t mode) {
  IdbAttrs attrs{};
  proxy([&](auto ctx) { _wasmfs_idb_get_attrs(ctx.ctx, id, root, &attrs); });
  if (attrs.err || attrs.kind != File::DirectoryKind) {
    return nullptr;
  }
  return std::make_shared<IdbDirectory>(*this, attrs);
}

} // anonymous namespace

extern "C" {

backend_t wasmfs_create_idb_backend(const char *database, uint32_t flags) {
  // The backend's thread starts synchronously, which would deadlock on the
  // browser's main thread.
  if (emscripten_is_main_browser_thread()) {
    return nullptr;
  }
  bool readOnly = (flags & WASMFS_IDB_READ_ONLY) != 0;
  auto backend = std::make_unique<IdbBackend>(readOnly);
  int id = 0;
  uint32_t root = 0;
  auto *closed = reinterpret_cast<int32_t *>(&backend->closed);
  backend->proxy([&](auto ctx) {
    _wasmfs_idb_open(ctx.ctx, database, defaultChunkSize, readOnly, closed, &id,
                     &root);
  });
  // Destroying the backend ends its thread.
  if (id <= 0) {
    return nullptr;
  }
  backend->id = id;
  backend->root = root;
  // WasmFS's backend_t and the public header's name the same pointer under
  // different types.
  return reinterpret_cast<backend_t>(
      wasmfs::wasmFS.addBackend(std::move(backend)));
}

void wasmfs_idb_backend_seal(backend_t backend) {
  static_cast<IdbBackend *>(reinterpret_cast<wasmfs::Backend *>(backend))
      ->readOnly.store(true);
}

int wasmfs_idb_backend_closed(backend_t backend) {
  auto *idb =
      static_cast<IdbBackend *>(reinterpret_cast<wasmfs::Backend *>(backend));
  return idb->closed.load() != 0;
}

void EMSCRIPTEN_KEEPALIVE _wasmfs_idb_record_entry(
    std::vector<Directory::Entry> *entries, const char *name, int kind) {
  entries->push_back({name, File::FileKind(kind), 0});
}

void EMSCRIPTEN_KEEPALIVE _wasmfs_idb_set_string(std::string *string,
                                                 const char *value) {
  *string = value;
}

} // extern "C"
