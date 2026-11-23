import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { open, rename, unlink, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { PipelineError } from "./errors.js";
import { documentStorageKey } from "./hash.js";

const unsafePath = () => new PipelineError("UNSAFE_PATH");

/** Resolve a portable relative key strictly beneath the private storage root. */
export function safePath(root, key) {
  const parts = typeof key === "string" ? key.split(/[/\\]/u) : [];
  // Reject Windows aliases, alternate streams, directory escapes and drive/UNC paths.
  if (
    !parts.length ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[<>:"|?*\p{Cc}]|[. ]$/u.test(part) ||
        /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part),
    )
  ) {
    throw unsafePath();
  }
  return path.resolve(root, ...parts);
}

/** Resolve a configured SQLite filename, which must be inside DATA_DIR. */
export function resolveDatabasePath(dataDir, filename, cwd) {
  if (!filename) return safePath(dataDir, "app.sqlite");
  if (filename.split(/[/\\]/u).includes("..")) throw unsafePath();
  return safePath(dataDir, path.relative(dataDir, path.resolve(cwd, filename)));
}

function ensureDirectory(directory) {
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  // lstat detects symlinks and Windows junctions instead of following them.
  if (!lstatSync(directory).isDirectory()) throw unsafePath();
}

function ensureParent(root, filename) {
  let directory = root;
  const parent = path.dirname(path.relative(root, filename));
  if (parent === ".") return;
  for (const part of parent.split(path.sep)) {
    directory = path.join(directory, part);
    ensureDirectory(directory);
  }
}

function assertRegularFileOrMissing(filename) {
  const stat = lstatSync(filename, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.nlink > 1)) throw unsafePath();
}

/** Read only a bounded regular file below the private root; reject linked ancestors. */
export async function readPrivateFile(root, key, { maxBytes, signal } = {}) {
  const filename = safePath(root, key);
  let directory = root;
  const parents = path
    .relative(root, path.dirname(filename))
    .split(path.sep)
    .filter(Boolean);
  for (const part of ["", ...parents]) {
    directory = path.join(directory, part);
    if (!lstatSync(directory).isDirectory()) throw unsafePath();
  }
  assertRegularFileOrMissing(filename);
  const file = await open(filename, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink > 1) throw unsafePath();
    if (maxBytes !== undefined && stat.size > maxBytes)
      throw new PipelineError("PDF_RESOURCE_LIMIT");
    const bytes = await file.readFile({ signal });
    if (maxBytes !== undefined && bytes.length > maxBytes)
      throw new PipelineError("PDF_RESOURCE_LIMIT");
    return bytes;
  } finally {
    await file.close();
  }
}

/** Initialize private data directories and prepare the SQLite location. */
export function prepareStorage({
  DATA_DIR: root,
  DATABASE_PATH: databasePath,
}) {
  try {
    const target = safePath(root, path.relative(root, databasePath));
    mkdirSync(path.dirname(root), { recursive: true, mode: 0o700 });
    ensureDirectory(root);
    for (const name of ["documents", "extracted", "intermediate"]) {
      ensureDirectory(safePath(root, name));
    }
    ensureParent(root, target);
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      assertRegularFileOrMissing(target + suffix);
    }
  } catch (cause) {
    if (cause instanceof PipelineError) throw cause;
    throw new PipelineError("FILE_IO_ERROR", undefined, {
      stage: "storage",
      cause,
    });
  }
}

/** Flush a private temporary file, then atomically publish it in the same directory. */
export async function atomicWrite(root, key, contents) {
  const target = safePath(root, key);
  const temp = path.join(path.dirname(target), `.${randomUUID()}.tmp`);
  let handle;
  let temporaryCreated = false;
  try {
    if (!lstatSync(root).isDirectory()) throw unsafePath();
    ensureParent(root, target);
    assertRegularFileOrMissing(target);
    handle = await open(temp, "wx", 0o600);
    temporaryCreated = true;
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temp, target);
    temporaryCreated = false;
    return target;
  } catch (cause) {
    if (cause instanceof PipelineError) throw cause;
    throw new PipelineError("FILE_IO_ERROR", undefined, {
      stage: "storage",
      cause,
    });
  } finally {
    try {
      if (handle) await handle.close();
    } finally {
      if (temporaryCreated) await unlink(temp).catch(() => {});
    }
  }
}

/** Stream, validate and atomically publish a private content-addressed PDF. */
export async function stageDocument(
  root,
  stream,
  { maxBytes, expectedBytes, signal, validate },
) {
  if (expectedBytes !== undefined && expectedBytes > maxBytes)
    throw new PipelineError("DOWNLOAD_TOO_LARGE");
  const directory = safePath(root, "documents");
  ensureDirectory(directory);
  const temp = path.join(directory, `.download-${randomUUID()}.tmp`);
  let file;
  let hasTemp = false;
  try {
    file = await open(temp, "wx", 0o600);
    hasTemp = true;
    const hash = createHash("sha256");
    let size = 0;
    let prefix = Buffer.alloc(0);
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      size += chunk.length;
      if (size > maxBytes) throw new PipelineError("DOWNLOAD_TOO_LARGE");
      if (prefix.length < 5) {
        prefix = Buffer.concat([prefix, chunk.subarray(0, 5 - prefix.length)]);
        if (prefix.length === 5 && !prefix.equals(Buffer.from("%PDF-")))
          throw new PipelineError("DOWNLOAD_INVALID_TYPE");
      }
      hash.update(chunk);
      await file.writeFile(chunk);
    }
    if (
      stream.complete === false ||
      (expectedBytes !== undefined && size !== expectedBytes)
    )
      throw new PipelineError("SOURCE_UNAVAILABLE", undefined, {
        retryable: true,
      });
    if (prefix.length < 5) throw new PipelineError("DOWNLOAD_INVALID_TYPE");
    await file.sync();
    await file.close();
    file = undefined;
    await validate(await readFile(temp, { signal }), signal);
    signal?.throwIfAborted();
    const digest = hash.digest("hex");
    const key = documentStorageKey(digest);
    const target = safePath(root, key);
    ensureParent(root, target);
    assertRegularFileOrMissing(target);
    // Two writers for the same digest can only publish identical validated bytes.
    await rename(temp, target);
    hasTemp = false;
    return { sha256: digest, storageRelativePath: key, sizeBytes: size };
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof PipelineError) throw cause;
    if (
      [
        "ECONNRESET",
        "ERR_STREAM_PREMATURE_CLOSE",
        "EPIPE",
        "UND_ERR_SOCKET",
        "UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
      ].includes(cause.code)
    )
      throw new PipelineError("SOURCE_UNAVAILABLE", undefined, {
        cause,
        retryable: true,
      });
    throw new PipelineError("FILE_IO_ERROR", undefined, {
      cause,
      retryable: true,
    });
  } finally {
    try {
      await file?.close();
    } finally {
      if (hasTemp) await unlink(temp).catch(() => {});
    }
  }
}

/** Remove abandoned writer temps only while holding exclusive ownership of the pipeline. */
export async function clearDownloadTemps(root) {
  const directory = safePath(root, "documents");
  ensureDirectory(directory);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && /^\.download-[\da-f-]{36}\.tmp$/u.test(entry.name))
      await unlink(safePath(root, `documents/${entry.name}`));
  }
}
