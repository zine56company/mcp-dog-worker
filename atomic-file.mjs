import { randomBytes } from "node:crypto";
import { copyFile, readFile, rename, rm, writeFile } from "node:fs/promises";

const RETRYABLE_REPLACE_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

/**
 * Replaces `target` with an already-written temporary file.
 *
 * Antivirus, indexing and concurrent readers can briefly deny a Windows
 * rename even when both paths are owned by this process. Retrying the same
 * atomic rename preserves the old-or-new reader contract; deleting the target
 * as a fallback would introduce a visible missing-file window.
 */
export async function replaceFileAtomically(
  temporary,
  target,
  {
    renameFile = rename,
    retryWait = wait,
    maxAttempts = 4,
    initialDelayMs = 10,
    maximumDelayMs = 250
  } = {}
) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await renameFile(temporary, target);
      return;
    } catch (error) {
      if (!RETRYABLE_REPLACE_CODES.has(error?.code) || attempt >= maxAttempts) throw error;
      const delay = Math.min(initialDelayMs * 2 ** Math.min(attempt - 1, 8), maximumDelayMs);
      await retryWait(delay);
    }
  }
}

export async function atomicWriteFile(target, contents, options = {}) {
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, contents, options);
    try {
      await replaceFileAtomically(temporary, target);
    } catch (error) {
      if (process.platform !== "win32" || !RETRYABLE_REPLACE_CODES.has(error?.code)) throw error;
      // A continuously-open Windows reader can deny every atomic rename.
      // Copying over the destination keeps completion moving; all status
      // readers use readJsonFile below and retry the brief in-place window.
      await copyFile(temporary, target);
      await rm(temporary, { force: true });
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function atomicWriteJson(target, value) {
  await atomicWriteFile(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export async function readJsonFile(
  target,
  { maxAttempts = 100, retryWait = wait, retryDelayMs = 5 } = {}
) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return JSON.parse(await readFile(target, "utf8"));
    } catch (error) {
      const retryable =
        error instanceof SyntaxError ||
        ["EACCES", "EBUSY", "ENOENT", "EPERM"].includes(error?.code);
      if (!retryable || attempt >= maxAttempts) throw error;
      await retryWait(retryDelayMs);
    }
  }
}
