/**
 * Paths for everything this plugin writes to disk.
 *
 * All plugin-owned files live under one directory inside Zotero's *data*
 * directory (the folder that holds `storage/`, `zotero.sqlite`, ...), not the
 * profile. That keeps user-visible data together and makes it obvious what to
 * delete to reclaim space.
 *
 * Nothing here is ever written into `storage/`, which Zotero manages and syncs
 * — writing there would risk corrupting attachment bookkeeping.
 */

const ROOT_DIR_NAME = "highlight-ask";

// Kept in step with `prefsPrefix` in package.json; this module has no imports
// by design, so it cannot read the generated config.
const PREFS_PREFIX = "extensions.zotero.highlightask";

function dataDir(): string {
  const dir = Zotero.DataDirectory?.dir;
  if (!dir) {
    throw new Error("Zotero.DataDirectory.dir is unavailable");
  }
  return dir;
}

/**
 * Join with the platform separator without pulling in a path library.
 *
 * The separator is taken from the parts themselves rather than from
 * `dataDir()`: joining an absolute path should not require the Zotero data
 * directory to be available, and calling `dataDir()` here made every join throw
 * when it was not.
 */
function join(...parts: string[]): string {
  const first = parts.find(Boolean) ?? "";
  const sep = first.includes("\\") ? "\\" : "/";
  return parts
    .filter(Boolean)
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, "") : p.replace(/^[\\/]+|[\\/]+$/g, "")))
    .join(sep);
}

export function pluginRootDir(): string {
  return join(dataDir(), ROOT_DIR_NAME);
}

export function sessionsDir(): string {
  return join(pluginRootDir(), "sessions");
}

export function logsDir(): string {
  return join(pluginRootDir(), "logs");
}

/**
 * Where capture previews are written.
 *
 * Configurable because the reader may want them next to the papers, on a
 * scratch volume, or simply somewhere easier to open than the Zotero data
 * directory. An empty preference keeps the default inside the plugin folder.
 *
 * A relative value is treated as a subdirectory of the plugin folder, so
 * `captures` works without the reader having to know the absolute path.
 */
export function screenshotDir(): string {
  let custom = "";
  try {
    // Read through Zotero.Prefs directly: this module deliberately has no
    // imports, so it can be used from anywhere without a dependency cycle.
    custom = String(
      Zotero.Prefs.get(`${PREFS_PREFIX}.screenshotDir`, true) || "",
    ).trim();
  } catch {
    custom = "";
  }
  if (!custom) {
    return join(pluginRootDir(), "debug");
  }
  // Tolerate either separator and a trailing one.
  const normalized = custom.replace(/[\\/]+$/, "");
  const isAbsolute = /^([a-zA-Z]:[\\/]|\/|\\\\)/.test(normalized);
  return isAbsolute ? normalized : join(pluginRootDir(), normalized);
}

export function requestLogPath(): string {
  return join(logsDir(), "requests.jsonl");
}

/** Create a directory if it is not there yet. Never throws. */
export async function ensureDir(path: string): Promise<boolean> {
  try {
    const exists = await IOUtils.exists(path);
    if (exists) {
      return true;
    }
    await IOUtils.makeDirectory(path, { ignoreExisting: true, createAncestors: true });
    return true;
  } catch (e) {
    Zotero.logError(
      new Error(`[Highlight Ask] could not create ${path}: ${(e as Error)?.message || e}`),
    );
    return false;
  }
}

/**
 * Write a file, creating parent directories as needed.
 * Returns false instead of throwing: a storage failure must never lose the
 * answer the user is looking at.
 */
export async function writeTextFile(
  path: string,
  contents: string,
): Promise<boolean> {
  try {
    const parent = path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
    if (parent && !(await ensureDir(parent))) {
      return false;
    }
    await Zotero.File.putContentsAsync(path, contents);
    return true;
  } catch (e) {
    Zotero.logError(
      new Error(`[Highlight Ask] could not write ${path}: ${(e as Error)?.message || e}`),
    );
    return false;
  }
}

export async function readTextFile(path: string): Promise<string | null> {
  try {
    if (!(await IOUtils.exists(path))) {
      return null;
    }
    // getContentsAsync can return a stream/ArrayBuffer for non-file inputs; for
    // a plain path it is a string. Coerce defensively so a surprise type does
    // not crash the caller.
    const contents = await Zotero.File.getContentsAsync(path);
    if (typeof contents === "string") {
      return contents;
    }
    if (contents == null) {
      return null;
    }
    return new TextDecoder().decode(
      contents instanceof Uint8Array
        ? contents
        : new Uint8Array(contents as ArrayBuffer),
    );
  } catch (e) {
    Zotero.logError(
      new Error(`[Highlight Ask] could not read ${path}: ${(e as Error)?.message || e}`),
    );
    return null;
  }
}

/**
 * Append a line to a file, used for the request log.
 *
 * `Zotero.File.putContentsAsync` writes atomically and has no append mode, so
 * this goes through `IOUtils.write` with `mode: "append"` — the same approach
 * Zotero itself uses when streaming a download to disk.
 */
export async function appendLine(path: string, line: string): Promise<boolean> {
  try {
    const parent = path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
    if (parent && !(await ensureDir(parent))) {
      return false;
    }
    const text = line.endsWith("\n") ? line : `${line}\n`;
    const bytes = new TextEncoder().encode(text);
    await IOUtils.write(path, bytes, { mode: "append" });
    return true;
  } catch (e) {
    // Logging must never break the feature it is logging.
    Zotero.debug(`[Highlight Ask] append to ${path} failed: ${(e as Error)?.message || e}`);
    return false;
  }
}
