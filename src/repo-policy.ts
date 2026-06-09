import { execFileSync } from "child_process";
import type {
  RepoIntegrationPolicy,
  RepoPolicyRecord,
  RepoProviderKind,
  WorktreeStrategy,
} from "./types";
import { isGitHubCLIAvailable } from "./worktree-repo";

export interface RepoIdentity {
  key: string;
  repoRoot: string;
  remoteUrl?: string;
  provider: RepoProviderKind;
}

export interface RepoPolicyResolution {
  identity?: RepoIdentity;
  policy?: RepoIntegrationPolicy;
  source: "stored" | "seeded" | "unknown" | "none";
  provider: RepoProviderKind;
  prAvailable: boolean;
  record?: RepoPolicyRecord;
}

export type EffectiveWorktreeStrategy = "ask" | "delegate" | "auto-merge" | "auto-pr";

export interface WorktreePolicyDecision {
  strategy?: EffectiveWorktreeStrategy;
  blocked?: boolean;
  reason?: string;
  allowedActions: {
    merge: boolean;
    pr: boolean;
  };
}

function runGit(cwd: string, args: string[]): string | undefined {
  try {
    const result = execFileSync("git", args, {
      cwd,
      timeout: 5_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return result || undefined;
  } catch {
    return undefined;
  }
}

export function normalizeRemoteUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim().replace(/\.git$/, "");
  const ssh = trimmed.match(/^git@([^:]+):(.+)$/);
  if (ssh) return `https://${ssh[1].toLowerCase()}/${ssh[2].toLowerCase()}`;
  const https = trimmed.match(/^https?:\/\/([^/]+)\/(.+)$/i);
  if (https) return `https://${https[1].toLowerCase()}/${https[2].toLowerCase()}`;
  return trimmed.toLowerCase();
}

export function detectRepoProvider(remoteUrl: string | undefined): RepoProviderKind {
  const normalized = normalizeRemoteUrl(remoteUrl);
  return normalized?.startsWith("https://github.com/") ? "github" : "unsupported";
}

export function resolveRepoIdentity(workdir: string): RepoIdentity | undefined {
  const repoRoot = runGit(workdir, ["rev-parse", "--show-toplevel"]);
  if (!repoRoot) return undefined;
  const remoteUrl =
    runGit(repoRoot, ["remote", "get-url", "origin"])
    ?? runGit(repoRoot, ["remote", "get-url", "upstream"]);
  const normalizedRemote = normalizeRemoteUrl(remoteUrl);
  const provider = detectRepoProvider(normalizedRemote);
  return {
    key: normalizedRemote ? `${repoRoot}|${normalizedRemote}` : repoRoot,
    repoRoot,
    remoteUrl: normalizedRemote,
    provider,
  };
}

export function seededRepoPolicy(identity: RepoIdentity | undefined): RepoIntegrationPolicy | undefined {
  if (!identity?.remoteUrl) return undefined;
  return identity.remoteUrl === "https://github.com/goldmar/openclaw-code-agent"
    ? "pr-required"
    : undefined;
}

export function createRepoPolicyRecord(
  identity: RepoIdentity,
  policy: RepoIntegrationPolicy,
  source: "stored" | "seeded" = "stored",
  nowIso: string = new Date().toISOString(),
): RepoPolicyRecord {
  return {
    key: identity.key,
    policy,
    repoRoot: identity.repoRoot,
    remoteUrl: identity.remoteUrl,
    provider: identity.provider,
    createdAt: nowIso,
    updatedAt: nowIso,
    source,
  };
}

export function isPrAvailableForResolution(resolution: Pick<RepoPolicyResolution, "provider">): boolean {
  return resolution.provider === "github" && isGitHubCLIAvailable();
}

export function resolveWorktreePolicyDecision(args: {
  requestedStrategy: WorktreeStrategy | undefined;
  policy: RepoIntegrationPolicy | undefined;
  prAvailable: boolean;
}): WorktreePolicyDecision {
  const requested = args.requestedStrategy;
  const allowedActions = {
    merge: args.policy !== "pr-required",
    pr: args.policy !== "never-pr" && args.prAvailable,
  };

  if (!requested || requested === "off" || requested === "manual") {
    return { allowedActions };
  }
  if (!args.policy) {
    return {
      strategy: requested === "auto-merge" || requested === "auto-pr" ? "ask" : requested,
      blocked: true,
      reason: "Repo integration policy is unknown.",
      allowedActions: { merge: false, pr: false },
    };
  }
  if (args.policy === "manual") {
    return {
      strategy: requested === "delegate" ? "delegate" : "ask",
      reason: "Repo policy requires manual follow-through.",
      allowedActions: { merge: false, pr: false },
    };
  }
  if (args.policy === "pr-required") {
    if (requested === "auto-merge") {
      return args.prAvailable
        ? { strategy: "auto-pr", reason: "Repo policy requires a PR; auto-merge was downgraded to auto-pr.", allowedActions }
        : { strategy: "ask", blocked: true, reason: "Repo policy requires a PR, but no supported PR provider is available.", allowedActions };
    }
    if (requested === "auto-pr") {
      return args.prAvailable
        ? { strategy: "auto-pr", allowedActions }
        : { strategy: "ask", blocked: true, reason: "Repo policy requires a PR, but no supported PR provider is available.", allowedActions };
    }
    return { strategy: requested, allowedActions };
  }
  if (args.policy === "never-pr") {
    if (requested === "auto-pr") {
      return {
        strategy: "ask",
        reason: "Repo policy forbids PR creation; auto-pr was downgraded to an explicit worktree decision.",
        allowedActions,
      };
    }
    return { strategy: requested, allowedActions };
  }
  if (requested === "auto-pr" && !args.prAvailable) {
    return {
      strategy: "ask",
      reason: "No supported PR provider is available; auto-pr was downgraded to an explicit worktree decision.",
      allowedActions,
    };
  }
  return { strategy: requested, allowedActions };
}

export function formatUnknownRepoPolicyMessage(identity: RepoIdentity, requestedStrategy: WorktreeStrategy): string {
  return [
    `Repo integration policy is not set for ${identity.repoRoot}.`,
    ``,
    `OCA will create isolated worktrees, but it needs a repo policy before follow-through can be automated.`,
    `Requested worktree strategy: ${requestedStrategy}`,
    `Provider: ${identity.provider}${identity.provider === "github" ? "" : " (PR automation unavailable)"}`,
    ``,
    `Set one policy, then launch again:`,
    `- agent_repo_policy(workdir="${identity.repoRoot}", policy="pr-required") for repos that must use PRs`,
    `- agent_repo_policy(workdir="${identity.repoRoot}", policy="pr-allowed") for repos where merge or PR are both acceptable`,
    `- agent_repo_policy(workdir="${identity.repoRoot}", policy="never-pr") for private/local repos that should not open PRs`,
    `- agent_repo_policy(workdir="${identity.repoRoot}", policy="manual") to require explicit follow-through every time`,
  ].join("\n");
}
