import { runGh, runGit } from "./git-exec";
import { localBranchRef } from "./worktree-ref-validation";
import { getBranchName } from "./worktree-repo";
import { getCommitsNotInPr, repoNameForGh, type PRStatus } from "./worktree-pr";
import type { PersistedSessionInfo } from "./types";

export type OwningPrResolution =
  | { kind: "none" }
  | { kind: "blocked"; reason: string }
  | { kind: "existing"; status: PRStatus; pushRemote: string };

type PrCandidate = {
  url: string; number: number; state: string; title?: string;
  headRefName: string; baseRefName: string; headRefOid?: string; mergedAt?: string;
  headRepository?: { nameWithOwner?: string } | null;
};

const PR_FIELDS = "url,number,title,state,headRefName,baseRefName,headRefOid,mergedAt,headRepository";

/** Resolve an existing owner, including a managed branch tracking a differently named PR head.
 * No branch movement, pushes, metadata changes, or session writes occur here.
 * A normal landing-base upstream is not an owning-PR association.
 */
export async function resolveOwningPr(args: {
  repoDir: string;
  worktreeBranch: string;
  baseBranch: string;
  expectedParentBranch?: string;
  recordedPrUrl?: string;
  recordedPrBaseBranch?: string;
  targetRepo?: string;
  pushRemote?: string;
  /** Retention supplements its existing recorded/branch lifecycle checks only for a different upstream. */
  upstreamOnly?: boolean;
}): Promise<OwningPrResolution> {
  try {
    const branchRef = await localBranchRef(args.worktreeBranch);
    const upstream = (await runGit(["-C", args.repoDir, "for-each-ref", "--format=%(upstream:remotename)%00%(upstream:remoteref)", branchRef], { timeout: 5_000 })).trim();
    const [upstreamRemote, upstreamRef] = upstream.split("\0");
    const upstreamBranch = upstreamRef?.startsWith("refs/heads/") ? upstreamRef.slice("refs/heads/".length) : undefined;
    const differentUpstream = upstreamBranch && upstreamBranch !== args.worktreeBranch && upstreamBranch !== args.baseBranch;
    if (args.upstreamOnly && !differentUpstream) return { kind: "none" };
    const currentParent = args.expectedParentBranch ? await getBranchName(args.repoDir) : undefined;
    const parent = currentParent === args.expectedParentBranch && currentParent !== args.worktreeBranch && currentParent !== args.baseBranch ? currentParent : undefined;
    if (!args.recordedPrUrl && !differentUpstream && !parent) return { kind: "none" };
    const pushRemote = args.pushRemote ?? "origin";
    const remoteName = async (remote: string) => repoNameForGh({ originUrl: (await runGit(["-C", args.repoDir, "remote", "get-url", remote], { timeout: 5_000 })).trim() });
    const pushRepo = await remoteName(pushRemote);
    const target = args.targetRepo ? repoNameForGh({ targetRepo: args.targetRepo }) : await remoteName("origin");
    if (!pushRepo || !target) return { kind: "blocked", reason: "Could not identify the PR target and push repositories" };
    // Resolve renames using explicitly named repositories, never gh's implicit remote preference.
    const canonical = async (name: string) => {
      const value = JSON.parse(await runGh(["repo", "view", name, "--json", "nameWithOwner"], { cwd: args.repoDir, timeout: 10_000 })) as { nameWithOwner?: string };
      if (!value.nameWithOwner) throw new Error("Repository identity unavailable");
      return value.nameWithOwner.toLowerCase();
    };
    const headRepo = await canonical(pushRepo.ghName);
    const baseRepo = pushRepo.ghName === target.ghName ? headRepo : await canonical(target.ghName);
    const repoHost = (name: string) => name.split("/").length === 3 ? name.split("/")[0]! : "github.com";
    const host = repoHost(target.ghName);
    if (repoHost(pushRepo.ghName) !== host) return { kind: "blocked", reason: "PR base and head repositories are on different hosts" };
    if (differentUpstream) {
      if (!upstreamRemote || upstreamRemote === ".") return { kind: "blocked", reason: "The owning upstream is not a remote branch" };
      const trackedRepo = await remoteName(upstreamRemote);
      if (!trackedRepo || repoHost(trackedRepo.ghName) !== host || (trackedRepo.ghName !== pushRepo.ghName && await canonical(trackedRepo.ghName) !== headRepo)) {
        return { kind: "blocked", reason: "The owning upstream does not belong to the selected push repository" };
      }
    }
    const validate = (pr: PrCandidate, head?: string, base?: string): PRStatus => {
      const url = new URL(pr.url);
      if (!Number.isSafeInteger(pr.number) || pr.number <= 0 || url.protocol !== "https:" || url.host.toLowerCase() !== host || url.pathname.toLowerCase() !== `/${baseRepo}/pull/${pr.number}`
        || pr.headRepository?.nameWithOwner?.toLowerCase() !== headRepo
        || !pr.headRefName || !pr.baseRefName || (head && pr.headRefName !== head) || (base && pr.baseRefName !== base)
        || !["OPEN", "CLOSED", "MERGED"].includes(pr.state)) throw new Error("PR repository, base, or head identity does not match the owning association");
      return { exists: true, state: pr.state.toLowerCase() as PRStatus["state"], url: pr.url, number: pr.number, title: pr.title,
        headRefName: pr.headRefName, baseRefName: pr.baseRefName, headRefOid: pr.headRefOid, mergedAt: pr.mergedAt, ownHead: true };
    };
    const recorded = args.recordedPrUrl
      ? validate(JSON.parse(await runGh(["pr", "view", args.recordedPrUrl, "--repo", target.ghName, "--json", PR_FIELDS], { cwd: args.repoDir, timeout: 10_000 })) as PrCandidate, undefined, args.recordedPrBaseBranch)
      : undefined;
    if (recorded && recorded.headRefName !== args.worktreeBranch && recorded.headRefName !== upstreamBranch && recorded.headRefName !== parent) {
      // An arbitrary URL is not an ownership receipt. Legacy follow-up links need a Git relationship too.
      const compared = await getCommitsNotInPr(args.repoDir, args.worktreeBranch, recorded, pushRemote);
      if (!compared) return { kind: "blocked", reason: "Could not verify the recorded PR head against the managed branch" };
      const ancestor = async (from: string, to: string) => {
        try { await runGit(["-C", args.repoDir, "merge-base", "--is-ancestor", from, to], { timeout: 5_000 }); return true; } catch { return false; }
      };
      if (!await ancestor(compared.headRef, branchRef) && !await ancestor(branchRef, compared.headRef)) {
        return { kind: "blocked", reason: "The recorded PR head is unrelated to the managed branch" };
      }
    }
    // Already-linked sessions keep the existing closed/merged lifecycle semantics.
    if (recorded && !differentUpstream) return { kind: "existing", status: recorded, pushRemote };
    const owners = new Map<string, PRStatus>();
    if (recorded?.state === "open") owners.set(recorded.url!, recorded);
    for (const head of new Set([...(differentUpstream ? [upstreamBranch!] : []), ...(parent ? [parent] : []), args.worktreeBranch])) {
      const candidates = JSON.parse(await runGh(["pr", "list", "--repo", target.ghName, "--head", head, "--base", args.baseBranch, "--state", "open", "--limit", "100", "--json", PR_FIELDS], { cwd: args.repoDir, timeout: 10_000 })) as PrCandidate[];
      if (!Array.isArray(candidates) || candidates.length >= 100) throw new Error("Incomplete owning PR lookup");
      for (const candidate of candidates) {
        // --head also returns other owners' forks. They cannot own this checkout.
        if (candidate.headRepository?.nameWithOwner && candidate.headRepository.nameWithOwner.toLowerCase() !== headRepo) continue;
        const status = validate(candidate, head, args.baseBranch);
        if (status.state === "open") owners.set(status.url!, status);
      }
    }
    if (owners.size > 1) return { kind: "blocked", reason: "Multiple existing PRs could own this worktree" };
    const owner = owners.values().next().value as PRStatus | undefined;
    if (recorded && owner && recorded.url !== owner.url) return { kind: "blocked", reason: "Recorded PR conflicts with the owning upstream" };
    if (owner || recorded) return { kind: "existing", status: (owner ?? recorded)!, pushRemote };
    // A differently named feature upstream is an association, not permission to open a sibling.
    return differentUpstream ? { kind: "blocked", reason: "No verified open PR found for the owning upstream" } : { kind: "none" };
  } catch {
    // Command errors can contain full command lines. Keep diagnostics bounded and free of PR bodies.
    return { kind: "blocked", reason: "Could not validate the owning PR association; nothing will be created or cleaned up" };
  }
}

export function owningPrLinkPatch(owner: Extract<OwningPrResolution, { kind: "existing" }>): Partial<PersistedSessionInfo> {
  return { worktreePrUrl: owner.status.url, worktreePrNumber: owner.status.number,
    worktreePrBaseBranch: owner.status.baseRefName, worktreePrHeadBranch: owner.status.headRefName, worktreePushRemote: owner.pushRemote };
}
