/**
 * Deterministic in-memory POSIX-like file system used by the terminal simulator.
 *
 * Deterministic on purpose: timestamps come from a logical clock instead of
 * Date.now(), so replaying the same command history on the server produces
 * exactly the same state as in the browser.
 */

export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
export const MAX_NODES = 20_000;

/** 2026-01-01T09:00:00Z – base for the logical clock. */
const CLOCK_EPOCH_MS = Date.UTC(2026, 0, 1, 9, 0, 0);

export type FsErrorCode = "ENOENT" | "ENOTDIR" | "EISDIR" | "EEXIST" | "ENOTEMPTY" | "EFBIG" | "EINVAL" | "ENOSPC";

const ERROR_TEXT: Record<FsErrorCode, string> = {
  ENOENT: "No such file or directory",
  ENOTDIR: "Not a directory",
  EISDIR: "Is a directory",
  EEXIST: "File exists",
  ENOTEMPTY: "Directory not empty",
  EFBIG: "File too large",
  EINVAL: "Invalid argument",
  ENOSPC: "No space left on device",
};

export class FsError extends Error {
  readonly code: FsErrorCode;
  readonly path: string;

  constructor(code: FsErrorCode, path: string) {
    super(ERROR_TEXT[code]);
    this.code = code;
    this.path = path;
  }
}

export interface FileNode {
  type: "file";
  content: string;
  executable: boolean;
  mtime: number;
}

export interface DirNode {
  type: "dir";
  children: Map<string, FsNode>;
  mtime: number;
}

export type FsNode = FileNode | DirNode;

export interface WalkEntry {
  path: string;
  node: FsNode;
  depth: number;
}

export function isDir(node: FsNode | null | undefined): node is DirNode {
  return !!node && node.type === "dir";
}

export function isFile(node: FsNode | null | undefined): node is FileNode {
  return !!node && node.type === "file";
}

/** Collapse `.`, `..` and duplicate slashes of an absolute path. */
export function normalizeAbsolute(path: string): string {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return "/" + out.join("/");
}

/** Resolve `path` against `cwd`, expanding a leading `~`. */
export function resolvePath(path: string, cwd: string, home: string): string {
  let p = path;
  if (p === "~") p = home;
  else if (p.startsWith("~/")) p = home + p.slice(1);
  if (!p.startsWith("/")) p = (cwd === "/" ? "" : cwd) + "/" + p;
  return normalizeAbsolute(p);
}

export function dirname(path: string): string {
  const normalized = normalizeAbsolute(path);
  if (normalized === "/") return "/";
  const idx = normalized.lastIndexOf("/");
  return idx <= 0 ? "/" : normalized.slice(0, idx);
}

export function basename(path: string): string {
  const normalized = normalizeAbsolute(path);
  if (normalized === "/") return "/";
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

export function joinPath(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

/** Display a path relative to `from` the way find/rg/fzf print them. */
export function relativePath(target: string, from: string): string {
  if (target === from) return ".";
  const prefix = from === "/" ? "/" : from + "/";
  if (target.startsWith(prefix)) return target.slice(prefix.length);
  const t = target.split("/").filter(Boolean);
  const f = from.split("/").filter(Boolean);
  let i = 0;
  while (i < t.length && i < f.length && t[i] === f[i]) i++;
  return [...Array(f.length - i).fill(".."), ...t.slice(i)].join("/") || ".";
}

function byteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

export class VirtualFileSystem {
  private root: DirNode;
  private clock: number;
  private totalBytes: number;
  private nodeCount: number;

  constructor() {
    this.clock = 0;
    this.root = { type: "dir", children: new Map(), mtime: 0 };
    this.totalBytes = 0;
    this.nodeCount = 1;
  }

  /** Logical time of a node as a real Date (for `ls -l`). */
  static toDate(mtime: number): Date {
    return new Date(CLOCK_EPOCH_MS + mtime * 60_000);
  }

  private tick(): number {
    this.clock += 1;
    return this.clock;
  }

  get(path: string): FsNode | null {
    const abs = normalizeAbsolute(path);
    if (abs === "/") return this.root;
    let node: FsNode = this.root;
    for (const segment of abs.slice(1).split("/")) {
      if (node.type !== "dir") return null;
      const next: FsNode | undefined = node.children.get(segment);
      if (!next) return null;
      node = next;
    }
    return node;
  }

  exists(path: string): boolean {
    return this.get(path) !== null;
  }

  isDirectory(path: string): boolean {
    return isDir(this.get(path));
  }

  isFile(path: string): boolean {
    return isFile(this.get(path));
  }

  /** Throws ENOENT/ENOTDIR like a real stat, distinguishing "a/file/x" from "a/missing/x". */
  stat(path: string): FsNode {
    const abs = normalizeAbsolute(path);
    if (abs === "/") return this.root;
    let node: FsNode = this.root;
    for (const segment of abs.slice(1).split("/")) {
      if (node.type !== "dir") throw new FsError("ENOTDIR", abs);
      const next: FsNode | undefined = node.children.get(segment);
      if (!next) throw new FsError("ENOENT", abs);
      node = next;
    }
    return node;
  }

  private parentDir(path: string): DirNode {
    const abs = normalizeAbsolute(path);
    const parent = this.stat(dirname(abs));
    if (parent.type !== "dir") throw new FsError("ENOTDIR", abs);
    return parent;
  }

  readFile(path: string): string {
    const node = this.stat(path);
    if (node.type === "dir") throw new FsError("EISDIR", normalizeAbsolute(path));
    return node.content;
  }

  writeFile(path: string, content: string, options: { append?: boolean; executable?: boolean } = {}): void {
    const abs = normalizeAbsolute(path);
    if (abs === "/") throw new FsError("EISDIR", abs);
    const parent = this.parentDir(abs);
    const name = basename(abs);
    const existing = parent.children.get(name);
    if (existing && existing.type === "dir") throw new FsError("EISDIR", abs);

    const next = options.append && existing ? existing.content + content : content;
    const nextBytes = byteLength(next);
    if (nextBytes > MAX_FILE_BYTES) throw new FsError("EFBIG", abs);
    const previousBytes = existing ? byteLength(existing.content) : 0;
    if (this.totalBytes - previousBytes + nextBytes > MAX_TOTAL_BYTES) throw new FsError("ENOSPC", abs);
    if (!existing && this.nodeCount >= MAX_NODES) throw new FsError("ENOSPC", abs);

    const mtime = this.tick();
    if (existing) {
      existing.content = next;
      existing.mtime = mtime;
      if (options.executable !== undefined) existing.executable = options.executable;
    } else {
      parent.children.set(name, {
        type: "file",
        content: next,
        executable: options.executable ?? false,
        mtime,
      });
      parent.mtime = mtime;
      this.nodeCount += 1;
    }
    this.totalBytes += nextBytes - previousBytes;
  }

  /** Update mtime or create an empty file (touch semantics). */
  touch(path: string): void {
    const node = this.get(path);
    if (node) {
      node.mtime = this.tick();
      return;
    }
    this.writeFile(path, "");
  }

  mkdir(path: string, options: { parents?: boolean } = {}): void {
    const abs = normalizeAbsolute(path);
    if (options.parents) {
      let node: DirNode = this.root;
      let current = "";
      for (const segment of abs.split("/").filter(Boolean)) {
        current += "/" + segment;
        const next = node.children.get(segment);
        if (!next) {
          if (this.nodeCount >= MAX_NODES) throw new FsError("ENOSPC", current);
          const created: DirNode = { type: "dir", children: new Map(), mtime: this.tick() };
          node.children.set(segment, created);
          node.mtime = created.mtime;
          this.nodeCount += 1;
          node = created;
        } else if (next.type === "dir") {
          node = next;
        } else {
          throw new FsError(current === abs ? "EEXIST" : "ENOTDIR", current);
        }
      }
      return;
    }
    if (abs === "/") throw new FsError("EEXIST", abs);
    const parent = this.parentDir(abs);
    const name = basename(abs);
    if (parent.children.has(name)) throw new FsError("EEXIST", abs);
    if (this.nodeCount >= MAX_NODES) throw new FsError("ENOSPC", abs);
    const mtime = this.tick();
    parent.children.set(name, { type: "dir", children: new Map(), mtime });
    parent.mtime = mtime;
    this.nodeCount += 1;
  }

  readdir(path: string): string[] {
    const node = this.stat(path);
    if (node.type !== "dir") throw new FsError("ENOTDIR", normalizeAbsolute(path));
    return [...node.children.keys()].sort(compareNames);
  }

  remove(path: string, options: { recursive?: boolean } = {}): void {
    const abs = normalizeAbsolute(path);
    if (abs === "/") throw new FsError("EINVAL", abs);
    const node = this.stat(abs);
    if (node.type === "dir" && !options.recursive) throw new FsError("EISDIR", abs);
    const parent = this.parentDir(abs);
    const { bytes, nodes } = measure(node);
    parent.children.delete(basename(abs));
    parent.mtime = this.tick();
    this.totalBytes -= bytes;
    this.nodeCount -= nodes;
  }

  rmdir(path: string): void {
    const abs = normalizeAbsolute(path);
    const node = this.stat(abs);
    if (node.type !== "dir") throw new FsError("ENOTDIR", abs);
    if (node.children.size > 0) throw new FsError("ENOTEMPTY", abs);
    this.remove(abs, { recursive: true });
  }

  copy(source: string, destination: string, options: { recursive?: boolean } = {}): void {
    const src = normalizeAbsolute(source);
    const dest = normalizeAbsolute(destination);
    const node = this.stat(src);
    if (node.type === "dir") {
      if (!options.recursive) throw new FsError("EISDIR", src);
      if (dest === src || dest.startsWith(src + "/")) throw new FsError("EINVAL", dest);
      const { bytes, nodes } = measure(node);
      if (this.totalBytes + bytes > MAX_TOTAL_BYTES || this.nodeCount + nodes > MAX_NODES) {
        throw new FsError("ENOSPC", dest);
      }
      const parent = this.parentDir(dest);
      const existing = parent.children.get(basename(dest));
      if (existing && existing.type !== "dir") throw new FsError("ENOTDIR", dest);
      const mtime = this.tick();
      if (existing && existing.type === "dir") {
        for (const [name, child] of node.children) {
          const childCopy = cloneNode(child, mtime);
          const replaced = existing.children.get(name);
          if (replaced) {
            const m = measure(replaced);
            this.totalBytes -= m.bytes;
            this.nodeCount -= m.nodes;
          }
          existing.children.set(name, childCopy);
        }
        existing.mtime = mtime;
        this.totalBytes += bytes;
        this.nodeCount += nodes - 1;
        return;
      }
      parent.children.set(basename(dest), cloneNode(node, mtime));
      parent.mtime = mtime;
      this.totalBytes += bytes;
      this.nodeCount += nodes;
      return;
    }
    this.writeFile(dest, node.content, { executable: node.executable });
  }

  move(source: string, destination: string): void {
    const src = normalizeAbsolute(source);
    const dest = normalizeAbsolute(destination);
    if (src === dest) return;
    if (src === "/" || dest.startsWith(src + "/")) throw new FsError("EINVAL", dest);
    const node = this.stat(src);
    const destParent = this.parentDir(dest);
    const existing = destParent.children.get(basename(dest));
    if (existing) {
      if (existing.type === "dir" && node.type !== "dir") throw new FsError("EISDIR", dest);
      if (existing.type !== "dir" && node.type === "dir") throw new FsError("ENOTDIR", dest);
      if (existing.type === "dir" && existing.children.size > 0) throw new FsError("ENOTEMPTY", dest);
      const m = measure(existing);
      this.totalBytes -= m.bytes;
      this.nodeCount -= m.nodes;
    }
    const srcParent = this.parentDir(src);
    srcParent.children.delete(basename(src));
    const mtime = this.tick();
    srcParent.mtime = mtime;
    destParent.children.set(basename(dest), node);
    destParent.mtime = mtime;
  }

  setExecutable(path: string, executable: boolean): void {
    const node = this.stat(path);
    if (node.type === "file") {
      node.executable = executable;
      node.mtime = this.tick();
    }
  }

  /** Depth-first, name-sorted traversal (the root itself is yielded with depth 0). */
  *walk(path: string, options: { maxDepth?: number } = {}): Generator<WalkEntry> {
    const start = normalizeAbsolute(path);
    const node = this.stat(start);
    const maxDepth = options.maxDepth ?? Infinity;
    const stack: WalkEntry[] = [{ path: start, node, depth: 0 }];
    while (stack.length > 0) {
      const entry = stack.pop() as WalkEntry;
      yield entry;
      if (entry.node.type === "dir" && entry.depth < maxDepth) {
        const names = [...entry.node.children.keys()].sort(compareNames).reverse();
        for (const name of names) {
          stack.push({
            path: joinPath(entry.path, name),
            node: entry.node.children.get(name) as FsNode,
            depth: entry.depth + 1,
          });
        }
      }
    }
  }

  /** Size in bytes as reported by `ls -l`. */
  sizeOf(node: FsNode): number {
    return node.type === "file" ? byteLength(node.content) : 4096;
  }

  clone(): VirtualFileSystem {
    const copy = new VirtualFileSystem();
    copy.root = cloneNode(this.root, null) as DirNode;
    copy.clock = this.clock;
    copy.totalBytes = this.totalBytes;
    copy.nodeCount = this.nodeCount;
    return copy;
  }

  /** Flat snapshot (same format as EnvironmentSpec.files). Useful for debugging and tests. */
  snapshot(): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const entry of this.walk("/")) {
      if (entry.path === "/") continue;
      if (entry.node.type === "dir") out[entry.path + "/"] = null;
      else out[entry.path] = entry.node.content;
    }
    return out;
  }
}

/** ls/rg ordering: case-insensitive, dotfiles sorted by their name without the dot. */
export function compareNames(a: string, b: string): number {
  const ka = a.replace(/^\.+/, "").toLowerCase();
  const kb = b.replace(/^\.+/, "").toLowerCase();
  if (ka < kb) return -1;
  if (ka > kb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function cloneNode(node: FsNode, mtime: number | null): FsNode {
  if (node.type === "file") {
    return { type: "file", content: node.content, executable: node.executable, mtime: mtime ?? node.mtime };
  }
  const children = new Map<string, FsNode>();
  for (const [name, child] of node.children) children.set(name, cloneNode(child, mtime));
  return { type: "dir", children, mtime: mtime ?? node.mtime };
}

function measure(node: FsNode): { bytes: number; nodes: number } {
  if (node.type === "file") return { bytes: byteLength(node.content), nodes: 1 };
  let bytes = 0;
  let nodes = 1;
  for (const child of node.children.values()) {
    const m = measure(child);
    bytes += m.bytes;
    nodes += m.nodes;
  }
  return { bytes, nodes };
}
