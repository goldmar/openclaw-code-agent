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

export type RepoPolicyOption = {
  policy: RepoIntegrationPolicy;
  label: string;
  title: string;
  description: string;
};

export const REPO_POLICY_OPTIONS: readonly RepoPolicyOption[] = [
  {
    policy: "pr-required",
    label: "Require PR",
    title: "Require PR",
    description: "Direct merge is disabled; follow-through must use a pull request.",
  },
  {
    policy: "pr-allowed",
    label: "Merge or PR",
    title: "Merge or PR",
    description: "Use the requested strategy; direct merge and pull requests are both allowed.",
  },
  {
    policy: "never-pr",
    label: "No PR",
    title: "No PR",
    description: "Do not create pull requests; keep follow-through local/direct.",
  },
  {
    policy: "manual",
    label: "Manual",
    title: "Manual",
    description: "Create isolated worktrees, but require an explicit human follow-up decision every time.",
  },
];

const REPO_POLICY_OPTION_BY_POLICY = new Map(REPO_POLICY_OPTIONS.map((option) => [option.policy, option]));

export function getRepoPolicyOption(policy: RepoIntegrationPolicy): RepoPolicyOption {
  return REPO_POLICY_OPTION_BY_POLICY.get(policy) ?? {
    policy,
    label: policy,
    title: policy,
    description: "Custom repo integration policy.",
  };
}

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
  const trimmed = url.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
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
    `OCA will create isolated worktrees, but it needs one repo policy before merge or PR follow-through can run.`,
    `Requested worktree strategy: ${requestedStrategy}`,
    `Provider: ${identity.provider}${identity.provider === "github" ? "" : " (PR automation unavailable)"}`,
    ``,
    `Choose one policy:`,
    ...REPO_POLICY_OPTIONS.map((option) => `- ${option.title}: ${option.description}`),
    ``,
    `If buttons are unavailable, set it manually. OCA will continue the pending launch automatically when exactly one matching launch is waiting; otherwise run the intended launch again:`,
    ...REPO_POLICY_OPTIONS.map((option) => `- agent_repo_policy(workdir="${identity.repoRoot}", policy="${option.policy}")`),
  ].join("\n");
}
