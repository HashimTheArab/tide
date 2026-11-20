import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { diskKey, diskPath, unescapeDiskPath } from "@tide/protocol";

import type { Bucket, ListEntry } from "./bucket.ts";
import { BucketError, byteOrder, checkEtag, checkKey } from "./bucket.ts";

export interface DiskOptions {
  readonly busyTimeoutMs?: number; // How long a writer waits for another writer's mutex.
  readonly now?: () => number; // The bucket's clock.
}

/** `.tide/` holds the writers' mutex and staged files; `diskPath` never yields a name that starts with `.`. */
const META = ".tide";
const HASH_CHUNK = 64 * 1024;
// O_NONBLOCK: opening a FIFO with no writer must fail the regular-file check, not block.
const READ_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK;
const etagOf = (bytes: Uint8Array) => `"${createHash("sha256").update(bytes).digest("hex")}"`;

/**
 * Returns a bucket over a directory, for tests and single-host development. Writers serialise on a SQLite lock
 * (`fcntl`), which the OS frees when its holder dies; each conditional write reads, compares and renames inside it.
 * Readers take no lock: a rename is atomic, and a read holds one open file. Network filesystems are not supported.
 */
export function diskBucket(root: string, options: DiskOptions = {}): Bucket {
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new BucketError(`disk bucket ${root} is not a directory`, "failed");
  }
  const { busyTimeoutMs = 10_000, now = Date.now } = options;
  const fail = (word: string, outcome: "failed" | "unknown" = "failed") =>
    new BucketError(`disk bucket ${root} ${word}`, outcome);
  const code = (e: unknown) => (e as NodeJS.ErrnoException).code ?? "error";
  const rootPresent = () => statSync(root, { throwIfNoEntry: false })?.isDirectory() === true;
  /** ENOENT under a present root is absence; under a missing root it is an outage. */
  const absent = (e: unknown): true => {
    if (code(e) !== "ENOENT") throw fail(`failed: ${code(e)}`);
    if (!rootPresent()) throw fail("unavailable");
    return true;
  };

  /** Creates one directory level, accepting only a real directory that is already there. */
  const ensureDir = (path: string) => {
    try {
      mkdirSync(path);
    } catch (e) {
      if (code(e) !== "EEXIST" || !isRealDirectory(path)) throw fail("unavailable");
    }
  };
  const ensureParents = (rel: string) => {
    const parts = rel.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) ensureDir(join(root, ...parts.slice(0, i)));
  };

  /** Returns an open descriptor's bytes, failing on anything but a regular file of at most `maxBytes`. */
  const readOpen = (fd: number, maxBytes: number): Uint8Array<ArrayBuffer> => {
    const st = fstatSync(fd);
    if (!st.isFile()) throw fail("not a regular file");
    if (st.size > maxBytes) throw fail(`object over ${maxBytes} bytes`);
    const bytes = new Uint8Array(st.size);
    for (let at = 0; at < bytes.length;) {
      const n = readSync(fd, bytes, at, bytes.length - at, null);
      if (n === 0) throw fail("object changed while read");
      at += n;
    }
    return bytes;
  };

  /** Returns the ETag of the regular file at `path`, hashed in chunks, or undefined when absent. */
  const storedEtag = (path: string): string | undefined => {
    let fd: number;
    try {
      fd = openSync(path, READ_FLAGS);
    } catch (e) {
      if (code(e) === "ENOENT") return undefined;
      throw fail(`failed: ${code(e)}`);
    }
    try {
      if (!fstatSync(fd).isFile()) throw fail("not a regular file");
      const hash = createHash("sha256");
      const chunk = new Uint8Array(HASH_CHUNK);
      for (let n; (n = readSync(fd, chunk, 0, chunk.length, null)) > 0;) {
        hash.update(chunk.subarray(0, n));
      }
      return `"${hash.digest("hex")}"`;
    } finally {
      closeSync(fd);
    }
  };

  /**
   * Runs `mutate` holding the writers' mutex, then releases it and removes `staged` if it was not renamed.
   * `mutate` calls `done()` right after its rename or unlink, so a later error is reported as `unknown`.
   */
  const locked = <T>(staged: string | undefined, mutate: (done: () => void) => T): T => {
    const unstage = () => {
      if (staged !== undefined) rmSync(staged, { force: true });
    };
    const db = acquire(unstage);
    let mutated = false;
    const toError = (e: unknown) => {
      const outcome = mutated ? "unknown" : "failed";
      return e instanceof BucketError
        ? new BucketError(e.message, outcome)
        : fail(`failed: ${code(e)}`, outcome);
    };
    const release = () => {
      try {
        db.exec("COMMIT");
      } finally {
        db.close();
        unstage();
      }
    };
    let result: T;
    try {
      result = mutate(() => (mutated = true));
    } catch (e) {
      try {
        release();
      } catch {
        // The mutation's own error is the one to report.
      }
      throw toError(e);
    }
    try {
      release();
    } catch (e) {
      throw toError(e);
    }
    return result;
  };

  /** Opens the mutex connection and takes the lock; on failure, unstages and throws `busy` or `unavailable`. */
  const acquire = (unstage: () => void): DatabaseSync => {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(join(root, META, "mutex.sqlite"), { timeout: busyTimeoutMs });
      db.exec("BEGIN IMMEDIATE");
      return db;
    } catch (e) {
      // No transaction began, so there is nothing to commit.
      if (db?.isOpen === true) db.close();
      unstage();
      const errcode = (e as { errcode?: number }).errcode;
      throw fail(errcode === 5 || errcode === 6 ? "busy" : "unavailable");
    }
  };

  /** Stages `bytes` beside the bucket, outside the mutex; returns the staged path and the bytes' ETag. */
  const stage = (bytes: Uint8Array) => {
    ensureDir(join(root, META));
    ensureDir(join(root, META, "tmp"));
    const staged = join(root, META, "tmp", randomUUID());
    try {
      writeFileSync(staged, bytes, { flag: "wx" });
    } catch (e) {
      rmSync(staged, { force: true });
      throw fail(`failed: ${code(e)}`);
    }
    return { staged, etag: etagOf(bytes) };
  };

  function write(key: string, bytes: Uint8Array): string;
  function write(
    key: string,
    bytes: Uint8Array,
    proceed: (target: string) => boolean,
  ): string | undefined;
  function write(
    key: string,
    bytes: Uint8Array,
    proceed: (target: string) => boolean = () => true,
  ): string | undefined {
    checkKey(key);
    const rel = diskPath(key);
    const target = join(root, rel);
    const { staged, etag } = stage(bytes);
    return locked(staged, (done) => {
      if (!proceed(target)) return undefined;
      ensureParents(rel);
      renameSync(staged, target);
      done();
      return etag;
    });
  }

  return {
    get: (key, maxBytes) =>
      settle(() => {
        checkKey(key);
        let fd: number;
        try {
          fd = openSync(join(root, diskPath(key)), READ_FLAGS);
        } catch (e) {
          absent(e);
          return undefined;
        }
        try {
          const bytes = readOpen(fd, maxBytes);
          return { bytes, etag: etagOf(bytes) };
        } finally {
          closeSync(fd);
        }
      }),

    put: (key, bytes) => settle(() => write(key, bytes)),

    putIfAbsent: (key, bytes) =>
      settle(() => write(key, bytes, (target) => !lstatSync(target, { throwIfNoEntry: false }))),

    putIfMatch: (key, bytes, etag) =>
      settle(() => {
        checkEtag(etag);
        return write(key, bytes, (target) => storedEtag(target) === etag);
      }),

    delete: (key) =>
      settle(() => {
        checkKey(key);
        const target = join(root, diskPath(key));
        ensureDir(join(root, META));
        locked(undefined, (done) => {
          try {
            unlinkSync(target);
          } catch (e) {
            absent(e);
            return;
          }
          done();
        });
      }),

    list: (prefix) => settle(() => listSync(prefix)),

    time: () => settle(now),
  };

  /**
   * False for content the server could not open: a bundle or asset key that is not a readable regular file, a symlink
   * followed. Other keys are always listed, so `status` can name what is wrong with them.
   */
  function servable(key: string, name: string): boolean {
    if (!key.startsWith("bundles/") && !key.startsWith("assets/")) return true;
    let fd;
    try {
      fd = openSync(join(root, name), READ_FLAGS);
    } catch {
      return false;
    }
    try {
      return fstatSync(fd).isFile();
    } finally {
      closeSync(fd);
    }
  }

  function listSync(prefix: string): ListEntry[] {
    const entries: ListEntry[] = [];
    const reaches = (name: string) =>
      `${name}/`.startsWith(prefix) || prefix.startsWith(`${name}/`);
    const walk = (rel: string) => {
      let dirents;
      try {
        dirents = readdirSync(rel === "" ? root : join(root, rel), { withFileTypes: true });
      } catch (e) {
        if (rel !== "" && code(e) === "ENOENT" && rootPresent()) return; // Removed mid-walk.
        throw rel === "" ? fail("unavailable") : fail(`failed: ${code(e)}`);
      }
      for (const d of dirents) {
        if (rel === "" && d.name === META) continue;
        const name = rel === "" ? d.name : `${rel}/${d.name}`;
        const key = diskKey(name);
        if (key !== undefined) entries.push(servable(key, name) ? { key } : { unknown: name });
        // A subtree that cannot hold a match is skipped, so its failures cannot fail this listing.
        else if (d.isDirectory()) {
          if (reaches(name) || reaches(unescapeDiskPath(name))) walk(name);
        } else entries.push({ unknown: name });
      }
    };
    walk("");
    // A file or symlink where a directory of the prefix belongs hides everything under it.
    if (entries.some((e) => "unknown" in e && prefix.startsWith(`${e.unknown}/`))) {
      throw fail("failed: ENOTDIR");
    }
    const name = (e: ListEntry) => ("key" in e ? e.key : e.unknown);
    return entries
      .filter((e) => name(e).startsWith(prefix))
      .sort((a, b) => byteOrder(name(a), name(b)));
  }
}

/** True for a directory, false for anything else, a symlink to a directory included. */
function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Returns `run`'s result as a promise, turning a synchronous throw into a rejection. */
function settle<T>(run: () => T): Promise<T> {
  return new Promise((resolve) => {
    resolve(run());
  });
}
