import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
import { buildMinimalChildEnv } from "./child-env";
import { runGit } from "./git-exec";
import { createLogger } from "./logger";

const log = createLogger("worktree-provisioning");

/**
 * New OCA worktrees follow OpenClaw's managed-worktree conventions
 * (docs/concepts/managed-worktrees.md):
 *
 * 1. `.worktreeinclude` at the source checkout root lists gitignored files to
 *    copy into the new worktree (gitignore syntax, evaluated by git itself).
 * 2. An executable `.openclaw/worktree-setup.sh` then runs inside the new
 *    worktree with a 120 s timeout.
 *
 * Both inputs are read from the commit the source checkout has checked out
 * (committed content only), because an agent can write to the working tree.
 *
 * Either step failing fails the worktree creation.
 */
const WORKTREE_INCLUDE_FILE = ".worktreeinclude";
const WORKTREE_SETUP_SCRIPT = join(".openclaw", "worktree-setup.sh");
const WORKTREE_SETUP_TIMEOUT_MS = 120_000;

const GIT_PATHSPEC_BATCH_MAX_PATHS = 128;
const GIT_PATHSPEC_BATCH_MAX_BYTES = 16 * 1024;
const SETUP_KILL_GRACE_MS = 300;
const SETUP_OUTPUT_TAIL_BYTES = 64 * 1024;
const SETUP_ERROR_TAIL_LINES = 12;
const SETUP_ERROR_MAX_CHARS = 2_000;
const PROVISION_GIT_TIMEOUT_MS = 30_000;

/** Repository hooks and fsmonitor never run for provisioning git calls. */
const HARDENED_GIT_CONFIG = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

function splitNul(output: string): string[] {
  return output.split("\0").filter((entry) => entry.length > 0);
}

function pathspecBatches(paths: string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    const size = Buffer.byteLength(path) + 1;
    if (current.length > 0 && (current.length >= GIT_PATHSPEC_BATCH_MAX_PATHS || bytes + size > GIT_PATHSPEC_BATCH_MAX_BYTES)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(path);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Relative, slash-separated path with no empty, `.`, or `..` segment. */
export function normalizeProvisionedRelativePath(value: string): string | undefined {
  if (!value || isAbsolute(value) || value.includes("\0")) return undefined;
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return undefined;
  return segments.join(sep);
}

/** Every existing parent must be a real directory, never a symlink. Missing parents are allowed. */
async function hasSafeParentDirectories(root: string, relativePath: string): Promise<boolean> {
  const segments = relativePath.split(sep).slice(0, -1);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    const entry = await lstat(current).catch((): undefined => undefined);
    if (!entry) return true;
    if (entry.isSymbolicLink() || !entry.isDirectory()) return false;
  }
  return true;
}

async function listIncludedIgnoredFiles(sourceRoot: string, includePath: string): Promise<string[]> {
  const matched = splitNul(await runGit(
    [...HARDENED_GIT_CONFIG, "ls-files", "--others", "--ignored", `--exclude-from=${includePath}`, "-z"],
    { cwd: sourceRoot, timeout: PROVISION_GIT_TIMEOUT_MS },
  ));
  const ignored: string[] = [];
  for (const batch of pathspecBatches(matched)) {
    ignored.push(...splitNul(await runGit(
      [...HARDENED_GIT_CONFIG, "--literal-pathspecs", "ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ...batch],
      { cwd: sourceRoot, timeout: PROVISION_GIT_TIMEOUT_MS },
    )));
  }
  return ignored;
}

/**
 * Keep only the paths the destination worktree also ignores. A recreated
 * worktree can check out a branch whose ignore rules differ from the source
 * checkout; copying a file it does not ignore would let the agent commit it.
 */
async function filterIgnoredInWorktree(worktreePath: string, paths: string[]): Promise<Set<string>> {
  const ignored = new Set<string>();
  for (const batch of pathspecBatches(paths)) {
    let output = "";
    try {
      output = await runGit(
        [...HARDENED_GIT_CONFIG, "check-ignore", "--no-index", "--stdin", "-z"],
        { cwd: worktreePath, timeout: PROVISION_GIT_TIMEOUT_MS, input: `${batch.join("\0")}\0` },
      );
    } catch (err) {
      // Exit status 1 means none of the batch is ignored; anything else is a real failure.
      if ((err as { code?: unknown }).code !== 1) throw err;
    }
    for (const path of splitNul(output)) ignored.add(path);
  }
  return ignored;
}

async function copyProvisionedFile(sourceRoot: string, worktreePath: string, relativePath: string): Promise<boolean> {
  const normalized = normalizeProvisionedRelativePath(relativePath);
  if (!normalized) return false;
  if (!(await hasSafeParentDirectories(sourceRoot, normalized))) return false;
  if (!(await hasSafeParentDirectories(worktreePath, normalized))) return false;
  const source = join(sourceRoot, normalized);
  const destination = join(worktreePath, normalized);
  const sourceStat = await lstat(source).catch((): undefined => undefined);
  if (!sourceStat?.isFile() || sourceStat.isSymbolicLink()) return false;
  if (await lstat(destination).catch((): undefined => undefined)) return false;
  await mkdir(dirname(destination), { recursive: true });
  // Re-check after creating parents: a racing symlink must not redirect the copy.
  if (!(await hasSafeParentDirectories(worktreePath, normalized))) return false;
  try {
    // COPYFILE_EXCL never overwrites, including a destination symlink; copyFile keeps the file mode.
    await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/**
 * The committed content of `relativePath` at `baseCommit` in the source
 * checkout, with its git file mode; undefined when the commit does not track it.
 * Worktree provisioning never reads a modified or untracked working-tree copy.
 */
async function readCommittedFile(
  sourceRoot: string,
  baseCommit: string | undefined,
  relativePath: string,
): Promise<{ content: Buffer; mode: string } | undefined> {
  if (!baseCommit) return undefined;
  let entry: string;
  try {
    entry = (await runGit(
      [...HARDENED_GIT_CONFIG, "ls-tree", "-z", baseCommit, "--", relativePath],
      { cwd: sourceRoot, timeout: PROVISION_GIT_TIMEOUT_MS },
    )).split("\0")[0] ?? "";
  } catch {
    return undefined;
  }
  const match = entry.match(/^(\d{6}) (\w+) ([0-9a-f]+)\t/);
  if (!match || match[2] !== "blob") return undefined;
  const content = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn("git", [...HARDENED_GIT_CONFIG, "cat-file", "blob", match[3]!], {
      cwd: sourceRoot,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`git cat-file exited ${code}`))));
  });
  return { content, mode: match[1]! };
}

async function withPrivateTempFile<T>(content: Buffer, mode: number, fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "oca-provision-"));
  try {
    const path = join(dir, "input");
    await writeFile(path, content, { mode });
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Copy the gitignored files selected by `.worktreeinclude` into a new
 * worktree. The include list is the version committed at `baseCommit` (the
 * source checkout's HEAD), never an untracked or modified working-tree copy.
 * Only files that are both matched by it and ignored by the repository's
 * standard excludes are copied; tracked files, symlinks, unsafe paths, and
 * existing destinations are skipped.
 *
 * @returns the relative paths that were copied, sorted.
 */
export async function provisionWorktreeIncludes(
  sourceRoot: string,
  worktreePath: string,
  options: { baseCommit?: string } = {},
): Promise<string[]> {
  const committed = await readCommittedFile(sourceRoot, options.baseCommit, WORKTREE_INCLUDE_FILE);
  if (!committed) return [];
  if (committed.mode === "120000") throw new Error(`${WORKTREE_INCLUDE_FILE} must be a regular file, not a symlink`);

  return withPrivateTempFile(committed.content, 0o600, async (includePath) => {
    const candidates = await listIncludedIgnoredFiles(sourceRoot, includePath);
    const ignoredInWorktree = candidates.length > 0 ? await filterIgnoredInWorktree(worktreePath, candidates) : new Set<string>();
    const copied: string[] = [];
    for (const relativePath of candidates) {
      if (!ignoredInWorktree.has(relativePath)) continue;
      if (await copyProvisionedFile(sourceRoot, worktreePath, relativePath)) copied.push(relativePath);
    }
    return copied.sort();
  });
}

class OutputTail {
  private chunks: Buffer[] = [];
  private bytes = 0;

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    while (this.bytes > SETUP_OUTPUT_TAIL_BYTES && this.chunks.length > 1) {
      this.bytes -= this.chunks.shift()!.length;
    }
  }

  lines(): string[] {
    return Buffer.concat(this.chunks).toString("utf8")
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/gu, "")
      .split(/\r?\n/u)
      .map((line) => line.split("\r").at(-1) ?? "")
      .filter((line) => line.trim().length > 0);
  }
}

function formatSetupFailure(reason: string, stdout: OutputTail, stderr: OutputTail): string {
  const tail = [...stderr.lines().slice(-SETUP_ERROR_TAIL_LINES), ...stdout.lines().slice(-SETUP_ERROR_TAIL_LINES)]
    .join("\n");
  const clipped = tail.length > SETUP_ERROR_MAX_CHARS ? tail.slice(tail.length - SETUP_ERROR_MAX_CHARS) : tail;
  return clipped ? `worktree setup failed (${reason}):\n${clipped}` : `worktree setup failed (${reason})`;
}

function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // Already exited.
  }
}

/**
 * Run `.openclaw/worktree-setup.sh` inside a new worktree when the version
 * committed at `baseCommit` (the source checkout's HEAD) is executable
 * (git mode 100755). A modified or untracked working-tree copy is never run.
 * The committed script runs from a private temporary copy (it needs its own
 * shebang) with the worktree as its working directory, in its own process
 * group, with a minimal allowlisted environment (see child-env.ts) plus
 * `OPENCLAW_SOURCE_TREE_PATH` and `OPENCLAW_WORKTREE_PATH`, no stdin, and a
 * 120 s timeout after which the whole process group is terminated.
 *
 * @returns true when a setup script ran; throws when it failed or timed out.
 */
export async function runWorktreeSetupScript(
  sourceRoot: string,
  worktreePath: string,
  options: { timeoutMs?: number; baseCommit?: string } = {},
): Promise<boolean> {
  const committed = await readCommittedFile(sourceRoot, options.baseCommit, WORKTREE_SETUP_SCRIPT.split(sep).join("/"));
  if (!committed || committed.mode !== "100755") return false;
  return withPrivateTempFile(committed.content, 0o700, (scriptPath) => runSetupScriptFile(scriptPath, sourceRoot, worktreePath, options));
}

async function runSetupScriptFile(
  scriptPath: string,
  sourceRoot: string,
  worktreePath: string,
  options: { timeoutMs?: number },
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? WORKTREE_SETUP_TIMEOUT_MS;
  const stdout = new OutputTail();
  const stderr = new OutputTail();
  log.info(`[worktree] Running ${WORKTREE_SETUP_SCRIPT} for ${worktreePath}`);

  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean; error?: Error }>((resolve) => {
    let timedOut = false;
    let settled = false;
    const child = spawn(scriptPath, [], {
      cwd: worktreePath,
      env: buildMinimalChildEnv(process.env, { OPENCLAW_SOURCE_TREE_PATH: sourceRoot, OPENCLAW_WORKTREE_PATH: worktreePath }),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      shell: false,
      windowsHide: true,
    });
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child.pid, "SIGTERM");
      forceKill = setTimeout(() => killProcessGroup(child.pid, "SIGKILL"), SETUP_KILL_GRACE_MS);
    }, timeoutMs);
    const finish = (result: { code: number | null; signal: NodeJS.Signals | null; error?: Error }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKill) clearTimeout(forceKill);
      // Descendants left behind by a failed or timed-out script are terminated too.
      if (timedOut || result.code !== 0) killProcessGroup(child.pid, "SIGKILL");
      resolve({ ...result, timedOut });
    };
    child.on("error", (error) => finish({ code: null, signal: null, error }));
    child.on("close", (code, signal) => finish({ code, signal }));
  });

  if (outcome.error) throw new Error(formatSetupFailure(outcome.error.message, stdout, stderr));
  if (outcome.timedOut) {
    throw new Error(formatSetupFailure(`timed out after ${Math.round(timeoutMs / 1000)} seconds`, stdout, stderr));
  }
  if (outcome.code !== 0) {
    throw new Error(formatSetupFailure(outcome.signal ? `signal ${outcome.signal}` : `exit code ${outcome.code}`, stdout, stderr));
  }
  return true;
}
