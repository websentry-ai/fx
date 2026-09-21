// Unbound fork addition: a read-only in-memory WASI filesystem for browser hosts.
//
// Upstream's browser surfaces answer every WASI path call with ENOTCAPABLE (52),
// so skill discovery, which scans real directories, finds nothing. This module
// backs the read calls with an in-memory tree so a host can supply skill files
// (`skills/<name>/SKILL.md`) without a real filesystem. Writes stay unavailable.

const ERR_SUCCESS = 0;
const ERR_BADF = 8;
const ERR_NOENT = 44;
const ERR_NOTDIR = 54;
const ERR_INVAL = 28;
const ERR_NOTCAPABLE = 52;

const FILETYPE_DIRECTORY = 3;
const FILETYPE_REGULAR = 4;

const OFLAG_CREAT = 1 << 0;
const OFLAG_DIRECTORY = 1 << 1;
const OFLAG_TRUNC = 1 << 3;

function normalizeParts(path) {
  const parts = [];
  for (const raw of String(path).split("/")) {
    if (!raw || raw === ".") continue;
    if (raw === "..") {
      parts.pop();
      continue;
    }
    parts.push(raw);
  }
  return parts;
}

/** Builds a directory tree from a flat `{ "skills/a/SKILL.md": "text" }` map. */
export function createMemFs({ root = "/workspace", files = {} } = {}) {
  const encoder = new TextEncoder();
  const tree = { type: "dir", entries: new Map() };

  const ensureDir = (parts) => {
    let node = tree;
    for (const part of parts) {
      let next = node.entries.get(part);
      if (!next) {
        next = { type: "dir", entries: new Map() };
        node.entries.set(part, next);
      }
      if (next.type !== "dir") throw new Error(`not a directory: ${part}`);
      node = next;
    }
    return node;
  };

  for (const [path, contents] of Object.entries(files)) {
    const parts = normalizeParts(path);
    if (parts.length === 0) continue;
    const name = parts.pop();
    ensureDir(parts).entries.set(name, {
      type: "file",
      data: typeof contents === "string" ? encoder.encode(contents) : contents,
    });
  }

  const rootParts = normalizeParts(root);

  /** Resolves an absolute-or-relative path to a node, or null. */
  const resolve = (path) => {
    let parts = normalizeParts(path);
    // Absolute paths must sit under the preopened root; strip its prefix.
    if (String(path).startsWith("/")) {
      for (let i = 0; i < rootParts.length; i++) {
        if (parts[i] !== rootParts[i]) return null;
      }
      parts = parts.slice(rootParts.length);
    }
    let node = tree;
    for (const part of parts) {
      if (node.type !== "dir") return null;
      const next = node.entries.get(part);
      if (!next) return null;
      node = next;
    }
    return node;
  };

  return { root, tree, resolve };
}

/**
 * Returns WASI handlers backed by `memfs`, plus the preopen fd it reserves.
 * `ctx` supplies memory accessors from the runtime: bytes(ptr,len), view().
 */
export function createWasiFs(memfs, ctx) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const PREOPEN_FD = 3;
  const handles = new Map();
  let nextFd = PREOPEN_FD + 1;

  handles.set(PREOPEN_FD, { node: memfs.tree, path: memfs.root, offset: 0 });

  const rootNameBytes = encoder.encode(memfs.root);

  const writeU8 = (ptr, value) => ctx.view().setUint8(ptr, value);
  const writeU32 = (ptr, value) => ctx.view().setUint32(ptr, value, true);
  const writeU64 = (ptr, value) => ctx.view().setBigUint64(ptr, BigInt(value), true);
  const fileType = (node) => (node.type === "dir" ? FILETYPE_DIRECTORY : FILETYPE_REGULAR);

  const filestat = (ptr, node) => {
    writeU64(ptr, 0); // dev
    writeU64(ptr + 8, 0); // ino
    writeU8(ptr + 16, fileType(node));
    for (let i = 17; i < 24; i++) writeU8(ptr + i, 0);
    writeU64(ptr + 24, 1); // nlink
    writeU64(ptr + 32, node.type === "file" ? node.data.length : 0);
    writeU64(ptr + 40, 0);
    writeU64(ptr + 48, 0);
    writeU64(ptr + 56, 0);
    return ERR_SUCCESS;
  };

  const pathOf = (dirfd, path) => {
    const handle = handles.get(dirfd);
    if (!handle) return null;
    if (String(path).startsWith("/")) return path;
    const base = handle.path === "/" ? "" : handle.path;
    return `${base}/${path}`;
  };

  /** Copies file bytes from `start` into the iovecs; returns the count copied. */
  const readInto = (data, start, iovsPtr, iovsLen) => {
    let at = start;
    for (let i = 0; i < iovsLen; i++) {
      const base = ctx.view().getUint32(iovsPtr + i * 8, true);
      const len = ctx.view().getUint32(iovsPtr + i * 8 + 4, true);
      const take = Math.min(len, data.length - at);
      if (take <= 0) break;
      ctx.bytes(base, take).set(data.subarray(at, at + take));
      at += take;
      if (take < len) break;
    }
    return at - start;
  };

  return {
    fd_prestat_get(fd, buf) {
      if (fd !== PREOPEN_FD) return ERR_BADF;
      writeU8(buf, 0); // preopentype: dir
      writeU32(buf + 4, rootNameBytes.length);
      return ERR_SUCCESS;
    },

    fd_prestat_dir_name(fd, ptr, len) {
      if (fd !== PREOPEN_FD) return ERR_BADF;
      if (len < rootNameBytes.length) return ERR_INVAL;
      ctx.bytes(ptr, rootNameBytes.length).set(rootNameBytes);
      return ERR_SUCCESS;
    },

    path_open(dirfd, _dirflags, pathPtr, pathLen, oflags, _rb, _ri, _fdflags, outFd) {
      if ((oflags & (OFLAG_CREAT | OFLAG_TRUNC)) !== 0) return ERR_NOTCAPABLE;
      const full = pathOf(dirfd, decoder.decode(ctx.bytes(pathPtr, pathLen)));
      if (full === null) return ERR_BADF;
      const node = memfs.resolve(full);
      if (!node) return ERR_NOENT;
      if ((oflags & OFLAG_DIRECTORY) !== 0 && node.type !== "dir") return ERR_NOTDIR;
      const fd = nextFd++;
      handles.set(fd, { node, path: full, offset: 0 });
      writeU32(outFd, fd);
      return ERR_SUCCESS;
    },

    path_filestat_get(dirfd, _flags, pathPtr, pathLen, buf) {
      const full = pathOf(dirfd, decoder.decode(ctx.bytes(pathPtr, pathLen)));
      if (full === null) return ERR_BADF;
      const node = memfs.resolve(full);
      if (!node) return ERR_NOENT;
      return filestat(buf, node);
    },

    fd_filestat_get(fd, buf) {
      const handle = handles.get(fd);
      if (!handle) return ERR_BADF;
      return filestat(buf, handle.node);
    },

    /** Reports the real file type; Zig rejects a file whose fdstat says unknown. */
    fd_fdstat_get(fd, out) {
      const handle = handles.get(fd);
      if (!handle) return ERR_BADF;
      ctx.bytes(out, 24).fill(0);
      writeU8(out, fileType(handle.node));
      writeU64(out + 8, 0xffffffffffffffffn);
      writeU64(out + 16, 0xffffffffffffffffn);
      return ERR_SUCCESS;
    },

    fd_readdir(fd, buf, bufLen, cookie, usedPtr) {
      const handle = handles.get(fd);
      if (!handle || handle.node.type !== "dir") return ERR_BADF;
      const entries = [...handle.node.entries.entries()];
      let offset = 0;
      let index = Number(cookie);
      while (index < entries.length) {
        const [name, node] = entries[index];
        const nameBytes = encoder.encode(name);
        const need = 24 + nameBytes.length;
        if (offset + need > bufLen) break;
        writeU64(buf + offset, index + 1); // d_next
        writeU64(buf + offset + 8, 0); // d_ino
        writeU32(buf + offset + 16, nameBytes.length);
        writeU8(buf + offset + 20, fileType(node));
        for (let i = 21; i < 24; i++) writeU8(buf + offset + i, 0);
        ctx.bytes(buf + offset + 24, nameBytes.length).set(nameBytes);
        offset += need;
        index += 1;
      }
      writeU32(usedPtr, offset);
      return ERR_SUCCESS;
    },

    fd_read(fd, iovsPtr, iovsLen, nreadPtr) {
      const handle = handles.get(fd);
      if (!handle || handle.node.type !== "file") return ERR_BADF;
      const read = readInto(handle.node.data, handle.offset, iovsPtr, iovsLen);
      handle.offset += read;
      writeU32(nreadPtr, read);
      return ERR_SUCCESS;
    },

    fd_pread(fd, iovsPtr, iovsLen, offset, nreadPtr) {
      const handle = handles.get(fd);
      if (!handle || handle.node.type !== "file") return ERR_BADF;
      writeU32(nreadPtr, readInto(handle.node.data, Number(offset), iovsPtr, iovsLen));
      return ERR_SUCCESS;
    },

    fd_seek(fd, offset, whence, outPtr) {
      const handle = handles.get(fd);
      if (!handle) return ERR_BADF;
      const size = handle.node.type === "file" ? handle.node.data.length : 0;
      const delta = Number(offset);
      if (whence === 0) handle.offset = delta;
      else if (whence === 1) handle.offset += delta;
      else handle.offset = size + delta;
      writeU64(outPtr, handle.offset);
      return ERR_SUCCESS;
    },

    fd_close(fd) {
      if (fd !== PREOPEN_FD) handles.delete(fd);
      return ERR_SUCCESS;
    },

    isOpen(fd) {
      return handles.has(fd);
    },
  };
}
