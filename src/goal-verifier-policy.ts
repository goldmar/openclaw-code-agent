import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { getGoalPolicyConfigurations, getGoalVerifierPolicyRevision, type GoalPolicyConfigurationSnapshot } from "./config";
import { resolveGoalRepositoryIdentity, sameGoalRepositoryIdentity } from "./goal-repository-identity";
import type { GoalRepositoryIdentity, GoalTaskState, GoalVerificationBinding, GoalVerifierSpec } from "./types";

const CONFIG_ERROR = "Invalid goalVerificationPolicies: configure absolute repository paths with non-empty ordered requiredCommands, and/or non-empty defaultRequiredCommands. Duplicate canonical repositories are denied.";
const LEGACY_ERROR = "requiredGoalVerifierCommands was removed. Migrate to goalVerificationPolicies.repositories with requiredCommands (or an explicit defaultRequiredCommands), then start new goals. Existing goal evidence is preserved.";
const BINDING_ERROR = "This goal has a legacy or invalid verification binding. Start a new goal after configuring goalVerificationPolicies; the original checks and historical evidence are preserved.";
const CHANGED_ERROR = "Goal verification policy or repository identity changed. Start a new goal; stored required and additional checks are never replaced.";

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function goalCommandStrings(raw: unknown, allowEmpty = false): string[] {
  const entries = Array.isArray(raw) ? Array.from(raw) : undefined;
  if (!entries || (!allowEmpty && entries.length === 0)
    || entries.some(entry => typeof entry !== "string" || !entry.trim())) throw new Error(CONFIG_ERROR);
  return (entries as string[]).map(entry => entry.trim());
}

export function verifierSpecCommands(specs: unknown, allowEmpty = false): string[] {
  const entries = Array.isArray(specs) ? Array.from(specs) : undefined;
  if (!entries || (!allowEmpty && entries.length === 0) || entries.some(spec => !record(spec)
    || typeof spec.label !== "string" || typeof spec.command !== "string" || !spec.command.trim())) {
    throw new Error("Invalid additional goal checks: use a dense array of non-blank shell commands.");
  }
  return entries.map(spec => (spec as GoalVerifierSpec).command.trim());
}

function sameCommands(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && Array.from(left).every((command, index) => command === right[index]);
}

type Selection = Pick<GoalVerificationBinding, "source" | "repository" | "requiredCommands" | "policyFingerprint">;
function selected(source: Selection["source"], requiredCommands: string[], repository?: string): Selection {
  const fields = { source, ...(repository ? { repository } : {}), requiredCommands };
  return { ...fields, policyFingerprint: createHash("sha256").update(JSON.stringify(fields)).digest("hex") };
}

async function policyForIdentity(snapshot: GoalPolicyConfigurationSnapshot, identity: GoalRepositoryIdentity): Promise<Selection> {
  if (snapshot.legacy !== undefined) throw new Error(LEGACY_ERROR);
  const raw = snapshot.policies;
  if (raw === undefined) return selected("none", []);
  if (!record(raw) || Object.keys(raw).some(key => !["repositories", "defaultRequiredCommands"].includes(key))) throw new Error(CONFIG_ERROR);
  const repositories = raw.repositories === undefined ? [] : Array.isArray(raw.repositories) ? Array.from(raw.repositories) : undefined;
  if (!repositories || (repositories.length === 0 && raw.defaultRequiredCommands === undefined)) throw new Error(CONFIG_ERROR);
  const fallback = raw.defaultRequiredCommands === undefined ? undefined : goalCommandStrings(raw.defaultRequiredCommands);
  const policies = await Promise.all(repositories.map(async entry => {
    if (!record(entry) || Object.keys(entry).some(key => !["repository", "requiredCommands"].includes(key))
      || typeof entry.repository !== "string" || !isAbsolute(entry.repository)) throw new Error(CONFIG_ERROR);
    const requiredCommands = goalCommandStrings(entry.requiredCommands);
    const repositoryIdentity = await resolveGoalRepositoryIdentity(entry.repository);
    if (repositoryIdentity.kind !== "git") throw new Error(CONFIG_ERROR);
    return { identity: repositoryIdentity, repository: entry.repository, requiredCommands };
  }));
  const seen = new Set<string>();
  for (const policy of policies) {
    const key = JSON.stringify(policy.identity);
    if (seen.has(key)) throw new Error(CONFIG_ERROR);
    seen.add(key);
  }
  const match = policies.find(policy => sameGoalRepositoryIdentity(policy.identity, identity));
  if (match) return selected("repository", match.requiredCommands, match.repository);
  if (fallback) return selected("default", fallback);
  throw new Error("No goal verification policy matches this repository or directory. The operator must configure its repository requiredCommands or explicit defaultRequiredCommands; callers cannot select another policy.");
}

export async function resolveGoalVerification(workdir: string, additional: readonly GoalVerifierSpec[] = []): Promise<{ binding: GoalVerificationBinding; revision: number }> {
  const additionalCommands = verifierSpecCommands(additional, true);
  for (;;) {
    const snapshot = getGoalPolicyConfigurations().at(-1)!;
    if (snapshot.legacy !== undefined) throw new Error(LEGACY_ERROR);
    const identity = await resolveGoalRepositoryIdentity(workdir);
    const selection = await policyForIdentity(snapshot, identity);
    const currentIdentity = await resolveGoalRepositoryIdentity(workdir);
    if (snapshot.revision !== getGoalVerifierPolicyRevision()) continue;
    if (!sameGoalRepositoryIdentity(identity, currentIdentity)) throw new Error(CHANGED_ERROR);
    return { binding: { version: 1, identity, ...selection, additionalCommands }, revision: snapshot.revision };
  }
}

export function effectiveGoalVerifiers(binding: GoalVerificationBinding, additional?: readonly GoalVerifierSpec[]): GoalVerifierSpec[] {
    return [...binding.requiredCommands, ...binding.additionalCommands].map((command, index) => {
    const extra = additional?.[index - binding.requiredCommands.length];
    return { label: extra && !/^check-\d+$/.test(extra.label.trim()) ? extra.label.trim() : `check-${index + 1}`, command,
      ...(extra?.timeoutMs !== undefined ? { timeoutMs: extra.timeoutMs } : {}) };
  });
}

function storedBinding(task: GoalTaskState): GoalVerificationBinding {
  const binding: unknown = task.goalVerificationBinding;
  if (task.requiredVerifierCommands !== undefined || !record(binding) || binding.version !== 1 || !record(binding.identity)
    || !["git", "directory"].includes(String(binding.identity.kind))
    || ["path", "device", "inode"].some(key => typeof (binding.identity as Record<string, unknown>)[key] !== "string")
    || !["repository", "default", "none"].includes(String(binding.source))
    || typeof binding.policyFingerprint !== "string" || (binding.source === "repository" && typeof binding.repository !== "string")) throw new Error(BINDING_ERROR);
  const required = goalCommandStrings(binding.requiredCommands, binding.source === "none");
  const additional = goalCommandStrings(binding.additionalCommands, true);
  const value = binding as unknown as GoalVerificationBinding;
  if (!sameCommands(required, value.requiredCommands) || !sameCommands(additional, value.additionalCommands)
    || selected(value.source, required, value.repository).policyFingerprint !== value.policyFingerprint
    || !sameCommands(verifierSpecCommands(task.verifierCommands, true), [...required, ...additional])) throw new Error(BINDING_ERROR);
  return value;
}

/** Per-controller transition cursor: historical and retired goals never acquire new bindings. */
export class GoalVerificationAuthority {
  private readonly observed = new WeakMap<GoalTaskState, number>();
  private readonly bindings = new WeakMap<GoalTaskState, string>();

  admit(task: GoalTaskState, revision: number): void {
    this.observed.set(task, revision);
    this.bindings.set(task, JSON.stringify(task.goalVerificationBinding));
  }

  async validate(task: GoalTaskState): Promise<number> {
    const binding = storedBinding(task);
    const signature = JSON.stringify(binding);
    if (this.bindings.has(task) && this.bindings.get(task) !== signature) throw new Error(CHANGED_ERROR);
    // At restore, begin with the current snapshot captured BEFORE any await,
    // then consume every transition occurring during identity/policy lookup.
    let after = this.observed.get(task) ?? (getGoalVerifierPolicyRevision() - 1);
    for (;;) {
      const identity = await resolveGoalRepositoryIdentity(task.workdir);
      if (!sameGoalRepositoryIdentity(binding.identity, identity)) throw new Error(CHANGED_ERROR);
      // Restore compares the current policy; a live task consumes every config
      // transition, including temporary mappings/aliases already reverted.
      let snapshots = getGoalPolicyConfigurations(after);
      if (snapshots.length === 0) snapshots = [getGoalPolicyConfigurations().at(-1)!];
      for (const snapshot of snapshots) {
        const policy = await policyForIdentity(snapshot, binding.identity);
        if (policy.policyFingerprint !== binding.policyFingerprint) throw new Error(CHANGED_ERROR);
        after = snapshot.revision;
      }
      const currentIdentity = await resolveGoalRepositoryIdentity(task.workdir);
      if (!sameGoalRepositoryIdentity(binding.identity, currentIdentity)) throw new Error(CHANGED_ERROR);
      if (after !== getGoalVerifierPolicyRevision()) continue;
      // Revalidate selection bytes before issuing a capability, not just the
      // repository and operator configuration consulted before the awaits.
      if (storedBinding(task) !== binding || JSON.stringify(binding) !== signature) throw new Error(CHANGED_ERROR);
      this.observed.set(task, after);
      this.bindings.set(task, signature);
      return after;
    }
  }
}
