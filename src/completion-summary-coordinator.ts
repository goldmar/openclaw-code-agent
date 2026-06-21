import { createHash } from "crypto";
import type { Session } from "./session";
import { getBackendConversationId, getPrimarySessionLookupRef } from "./session-backend-ref";
import { resolveNotificationRoute } from "./session-route";
import type { PersistedSessionInfo, SessionCompletionSummaryRecord } from "./types";

export type CompletionSummaryProducer =
  | "terminal"
  | "goal"
  | "worktree"
  | "worktree-pr"
  | "legacy";

export interface CompletionSummaryFact {
  required: boolean;
  producer: CompletionSummaryProducer;
  outcomeKey?: string;
  fallbackFingerprint?: string;
}

export type CompletionSummarySession = Pick<
  Session,
  "id" | "harnessSessionId" | "backendRef" | "route" | "originChannel" | "originThreadId" | "originSessionKey"
> & {
  name?: string;
  goalTaskId?: string;
  sessionId?: string;
};

export type PersistedCompletionSummarySession = Pick<
  PersistedSessionInfo,
  | "sessionId"
  | "harnessSessionId"
  | "backendRef"
  | "route"
  | "name"
  | "originChannel"
  | "originThreadId"
  | "originSessionKey"
  | "goalTaskId"
> & {
  id?: string;
};

export interface CompletionSummaryDecision {
  required: boolean;
  allowed: boolean;
  key?: string;
  dedupeKey?: string;
  explicit: boolean;
  skipReason?: string;
  records?: SessionCompletionSummaryRecord[];
}

interface CompletedSummaryRecord {
  skipReason: string;
}

interface CompletionSummaryKeySet {
  primary: string;
  explicit: boolean;
  claimKeys: string[];
  decisionKeys: string[];
}

interface NormalizedWorktreePrOutcome {
  primary: string;
  aliases: string[];
  blocksAliases: boolean;
}

export interface CompletionSummaryCoordinatorOptions {
  maxCompletedKeys?: number;
}

const DEFAULT_MAX_COMPLETED_KEYS = 1024;
const DUPLICATE_REASON = "duplicate completion follow-up wake already handled";
export const PRIOR_VISIBLE_SUMMARY_SKIP_REASON =
  "prior human-visible summary already delivered";

export class CompletionSummaryCoordinator {
  private readonly inFlight = new Set<string>();
  private readonly completed = new Map<string, CompletedSummaryRecord>();
  private readonly claimKeysByPrimary = new Map<string, string[]>();
  private readonly maxCompletedKeys: number;

  constructor(options: CompletionSummaryCoordinatorOptions = {}) {
    this.maxCompletedKeys = Math.max(
      1,
      Math.floor(options.maxCompletedKeys ?? DEFAULT_MAX_COMPLETED_KEYS),
    );
  }

  decide(
    session: CompletionSummarySession | PersistedCompletionSummarySession,
    fact: CompletionSummaryFact | undefined,
    persistedRecords?: SessionCompletionSummaryRecord[],
  ): CompletionSummaryDecision {
    if (fact?.required !== true) {
      return { required: false, allowed: false, explicit: false };
    }

    const keys = this.buildKeySet(session, fact);
    if (!keys) {
      return { required: true, allowed: true, explicit: false };
    }

    const normalizedRecords = this.normalizeRecords(persistedRecords);
    const persistedKeys = new Map(normalizedRecords.map((record) => [record.key, record]));
    const blockingKey = keys.decisionKeys.find((candidate) =>
      this.inFlight.has(candidate) || this.completed.has(candidate) || persistedKeys.has(candidate)
    );
    const completedRecord = blockingKey ? this.completed.get(blockingKey) : undefined;
    const persistedRecord = blockingKey ? persistedKeys.get(blockingKey) : undefined;
    if (blockingKey) {
      return {
        required: true,
        allowed: false,
        explicit: keys.explicit,
        dedupeKey: keys.primary,
        skipReason: completedRecord?.skipReason ?? persistedRecord?.skipReason ?? DUPLICATE_REASON,
      };
    }

    this.registerClaim(keys.primary, keys.claimKeys);
    return {
      required: true,
      allowed: true,
      key: keys.primary,
      explicit: keys.explicit,
    };
  }

  recordVisibleDelivery(
    session: CompletionSummarySession | PersistedCompletionSummarySession,
    fact: CompletionSummaryFact,
    persistedRecords?: SessionCompletionSummaryRecord[],
    label?: string,
  ): CompletionSummaryDecision {
    if (fact.required !== true) {
      return { required: false, allowed: false, explicit: false };
    }

    const keys = this.buildKeySet(session, fact);
    if (!keys) {
      return { required: true, allowed: true, explicit: false };
    }

    const normalizedRecords = this.normalizeRecords(persistedRecords);
    const persistedKeys = new Map(normalizedRecords.map((record) => [record.key, record]));
    const completedKey = keys.decisionKeys.find((candidate) => this.completed.has(candidate) || persistedKeys.has(candidate));
    const completedRecord = completedKey ? this.completed.get(completedKey) : undefined;
    const persistedRecord = completedKey ? persistedKeys.get(completedKey) : undefined;
    if (completedRecord || persistedRecord) {
      return {
        required: true,
        allowed: false,
        explicit: keys.explicit,
        dedupeKey: keys.primary,
        skipReason: completedRecord?.skipReason ?? persistedRecord?.skipReason,
      };
    }

    this.finishKeys(keys.primary, keys.claimKeys, true, PRIOR_VISIBLE_SUMMARY_SKIP_REASON);
    const records = this.deliveredRecords(
      keys.claimKeys,
      normalizedRecords,
      label,
      PRIOR_VISIBLE_SUMMARY_SKIP_REASON,
    );
    return {
      required: true,
      allowed: true,
      key: keys.primary,
      explicit: keys.explicit,
      records,
    };
  }

  finish(key: string | undefined, completed: boolean, skipReason = DUPLICATE_REASON): void {
    if (!key) return;
    const claimKeys = this.claimKeysByPrimary.get(key) ?? [key];
    this.finishKeys(key, claimKeys, completed, skipReason);
  }

  completionRecordsAfterDelivery(
    key: string | undefined,
    persistedRecords: SessionCompletionSummaryRecord[] | undefined,
    label?: string,
    skipReason = DUPLICATE_REASON,
  ): SessionCompletionSummaryRecord[] | undefined {
    if (!key) return undefined;
    const claimKeys = this.claimKeysByPrimary.get(key) ?? [key];
    return this.deliveredRecords(claimKeys, persistedRecords, label, skipReason);
  }

  private registerClaim(primary: string, claimKeys: string[]): void {
    for (const key of claimKeys) {
      this.inFlight.add(key);
    }
    this.claimKeysByPrimary.delete(primary);
    this.claimKeysByPrimary.set(primary, claimKeys);

    while (this.claimKeysByPrimary.size > this.maxCompletedKeys) {
      const oldestPrimary = this.claimKeysByPrimary.keys().next().value;
      if (oldestPrimary === undefined) break;
      const oldestClaimKeys = this.claimKeysByPrimary.get(oldestPrimary) ?? [oldestPrimary];
      for (const key of oldestClaimKeys) {
        this.inFlight.delete(key);
      }
      this.claimKeysByPrimary.delete(oldestPrimary);
    }
  }

  private finishKeys(
    primary: string,
    keys: string[],
    completed: boolean,
    skipReason = DUPLICATE_REASON,
  ): void {
    for (const key of keys) {
      this.inFlight.delete(key);
    }
    this.claimKeysByPrimary.delete(primary);
    if (!completed) return;

    for (const key of keys) {
      const completedRecord = this.completed.get(key);
      if (
        completedRecord?.skipReason === PRIOR_VISIBLE_SUMMARY_SKIP_REASON
        && skipReason !== PRIOR_VISIBLE_SUMMARY_SKIP_REASON
      ) {
        continue;
      }

      this.completed.delete(key);
      this.completed.set(key, { skipReason });
    }

    while (this.completed.size > this.maxCompletedKeys) {
      const oldestKey = this.completed.keys().next().value;
      if (oldestKey === undefined) break;
      this.completed.delete(oldestKey);
    }
  }

  private buildKeySet(
    session: CompletionSummarySession | PersistedCompletionSummarySession,
    fact: CompletionSummaryFact,
  ): CompletionSummaryKeySet | undefined {
    const deliveryRef = this.getDeliveryRef(session);
    if (!deliveryRef) return undefined;

    const outcomeKey = this.normalizeOutcomeKey(session, fact.outcomeKey?.trim());
    if (outcomeKey) {
      const primary = `${this.buildVisibleScope(deliveryRef, session)}:outcome:${this.digest(outcomeKey)}`;
      const goalLike = this.isGoalLike(session, fact, outcomeKey);
      const visibleSessionKeys = this.buildSessionAliasKeys(deliveryRef, session, "visible-summary");
      const goalSessionKeys = this.buildSessionAliasKeys(deliveryRef, session, "goal-summary");
      const terminalLike = this.isTerminalLike(fact, outcomeKey);
      const prOutcome = this.normalizeWorktreePrOutcome(fact.outcomeKey?.trim());
      const prAliasKeys = prOutcome?.aliases.map((alias) =>
        `${this.buildVisibleScope(deliveryRef, session)}:outcome:${this.digest(alias)}`
      ) ?? [];
      return {
        primary,
        explicit: true,
        claimKeys: [
          ...visibleSessionKeys,
          ...(goalLike ? goalSessionKeys : []),
          ...prAliasKeys,
          primary,
        ],
        decisionKeys: [
          primary,
          ...(prOutcome?.blocksAliases ? prAliasKeys : []),
          ...(goalLike || terminalLike ? visibleSessionKeys : []),
          ...goalSessionKeys,
        ],
      };
    }

    const fingerprint = fact.fallbackFingerprint?.trim();
    if (!fingerprint) return undefined;
    const primary = `${deliveryRef}:${fact.producer}:${this.digest(fingerprint)}`;
    return {
      primary,
      explicit: false,
      claimKeys: [primary],
      decisionKeys: [primary],
    };
  }

  private isGoalLike(
    session: CompletionSummarySession | PersistedCompletionSummarySession,
    fact: CompletionSummaryFact,
    outcomeKey: string,
  ): boolean {
    return Boolean(session.goalTaskId?.trim()) || fact.producer === "goal" || /^goal:/i.test(outcomeKey);
  }

  private isTerminalLike(fact: CompletionSummaryFact, outcomeKey: string): boolean {
    return fact.producer === "terminal" || /^terminal:/i.test(outcomeKey);
  }

  private normalizeOutcomeKey(
    session: CompletionSummarySession | PersistedCompletionSummarySession,
    outcomeKey: string | undefined,
  ): string | undefined {
    const goalTaskId = session.goalTaskId?.trim();
    if (goalTaskId) return `goal:${goalTaskId}`;
    const prOutcome = this.normalizeWorktreePrOutcome(outcomeKey);
    if (prOutcome) return prOutcome.primary;
    return outcomeKey;
  }

  private normalizeWorktreePrOutcome(outcomeKey: string | undefined): NormalizedWorktreePrOutcome | undefined {
    if (!outcomeKey) return undefined;
    const parts = outcomeKey.split(":");
    if (parts[0] !== "worktree-pr" || parts.length < 5) return undefined;

    const action = parts[1]?.trim().toLowerCase();
    if (!action || !/^(?:draft-)?(?:opened|updated)$/.test(action)) return undefined;

    const repo = parts[2]?.trim() || "default-repo";
    const rawPrIdentity = parts[3]?.trim();
    if (!rawPrIdentity) return undefined;
    const prIdentity = this.normalizePrIdentity(rawPrIdentity);
    const branch = parts[4]?.trim();
    if (!prIdentity || !branch) return undefined;

    const base = ["worktree-pr", repo.toLowerCase(), prIdentity, branch].join(":");
    const createdAlias = `${base}:created`;
    if (action.endsWith("updated")) {
      const materialChange = parts.slice(5).join(":").trim();
      const primary = materialChange
        ? `${base}:updated:${materialChange}`
        : `${base}:updated`;
      return {
        primary,
        aliases: [createdAlias],
        blocksAliases: false,
      };
    }

    return {
      primary: createdAlias,
      aliases: [],
      blocksAliases: true,
    };
  }

  private normalizePrIdentity(value: string): string | undefined {
    const numberMatch = value.match(/#?(\d+)$/);
    if (numberMatch?.[1]) return `#${numberMatch[1]}`;
    const urlMatch = value.match(/\/pull\/(\d+)(?:\b|\/|$)/);
    if (urlMatch?.[1]) return `#${urlMatch[1]}`;
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }

  private buildVisibleScope(
    deliveryRef: string,
    session: CompletionSummarySession | PersistedCompletionSummarySession,
  ): string {
    const route = resolveNotificationRoute(session);
    if (!route) return deliveryRef;
    return `route:${this.digest(JSON.stringify({
      provider: route.provider,
      accountId: route.accountId,
      target: route.target,
      threadId: route.threadId,
    }))}`;
  }

  private buildSessionAliasKeys(
    deliveryRef: string,
    session: CompletionSummarySession | PersistedCompletionSummarySession,
    aliasKind: "visible-summary" | "goal-summary",
  ): string[] {
    const scope = this.buildVisibleScope(deliveryRef, session);
    const refs = [
      "id" in session ? session.id : undefined,
      "sessionId" in session ? session.sessionId : undefined,
      session.name,
      getBackendConversationId(session),
      session.harnessSessionId,
      deliveryRef,
    ]
      .map((ref) => ref?.trim())
      .filter((ref): ref is string => Boolean(ref));
    return [...new Set(refs)]
      .map((ref) => `${scope}:session:${this.digest(ref)}:${aliasKind}`);
  }

  private getDeliveryRef(session: CompletionSummarySession | PersistedCompletionSummarySession): string {
    return getPrimarySessionLookupRef(session) ?? getBackendConversationId(session) ?? "";
  }

  private digest(value: string): string {
    return createHash("sha256").update(value).digest("hex").slice(0, 16);
  }

  private normalizeRecords(records: SessionCompletionSummaryRecord[] | undefined): SessionCompletionSummaryRecord[] {
    if (!records?.length) return [];
    return records
      .filter((record) => record.key.trim() && Number.isFinite(Date.parse(record.recordedAt)))
      .slice(-this.maxCompletedKeys);
  }

  private deliveredRecords(
    keys: string[],
    persistedRecords: SessionCompletionSummaryRecord[] | undefined,
    label?: string,
    skipReason = DUPLICATE_REASON,
  ): SessionCompletionSummaryRecord[] {
    const now = new Date().toISOString();
    const normalizedRecords = this.normalizeRecords(persistedRecords);
    const withoutKeys = normalizedRecords.filter((record) => !keys.includes(record.key));
    const nextRecords = [
      ...withoutKeys,
      ...keys.map((key) => ({
        key,
        recordedAt: now,
        label,
        skipReason,
      })),
    ];
    return nextRecords.slice(Math.max(0, nextRecords.length - this.maxCompletedKeys));
  }
}
