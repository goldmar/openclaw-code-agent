import { runGit } from "./git-exec";

const REF_FORMAT_TIMEOUT_MS = 5_000;

async function isValidRefFormat(ref: string): Promise<boolean> {
  try {
    await runGit(["check-ref-format", ref], { timeout: REF_FORMAT_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/** Local branch names only: reject standard full-ref namespaces, options, and revisions. */
export async function branchNameValidationError(value: unknown): Promise<string | undefined> {
  if (typeof value !== "string" || !value || value.startsWith("-") || /^refs\/(?:heads|remotes|tags)\//u.test(value) || value === "HEAD" || value === "@" || /\s|[\x00-\x1f\x7f]/u.test(value)) {
    return "Expected a literal Git branch name (local branch only; not a full ref, option, or revision expression).";
  }
  // Prefixing the argument prevents option parsing and avoids --branch's @{-n}
  // expansion. Git owns the remaining ref grammar, including slash components.
  return await isValidRefFormat(`refs/heads/${value}`)
    ? undefined
    : "Expected a valid literal Git branch name; Git ref validation failed.";
}

export async function assertBranchName(value: unknown): Promise<void> {
  const error = await branchNameValidationError(value);
  if (error) throw new Error(error);
}

/** Fully qualify a validated local branch anywhere Git performs revision lookup. */
export async function localBranchRef(value: unknown): Promise<string> {
  await assertBranchName(value);
  return `refs/heads/${value as string}`;
}

/** Read-only ancestry checks may compare a local branch with a computed remote-tracking ref. */
export async function assertBranchOrRemoteTrackingRef(value: unknown): Promise<void> {
  if (typeof value === "string" && value.startsWith("refs/remotes/")) {
    if (await isValidRefFormat(value)) return;
    throw new Error("Expected a valid literal Git branch or remote-tracking ref.");
  }
  await assertBranchName(value);
}

/** Qualify local branches while preserving validated, internally computed remote refs. */
export async function branchOrRemoteTrackingRef(value: unknown): Promise<string> {
  await assertBranchOrRemoteTrackingRef(value);
  const ref = value as string;
  return ref.startsWith("refs/remotes/") ? ref : `refs/heads/${ref}`;
}
