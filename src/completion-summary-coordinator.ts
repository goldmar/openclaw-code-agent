import { createHash } from "crypto";
import type { Session } from "./session";
import { getBackendConversationId, getPrimarySessionLookupRef } from "./session-backend-ref";
import { resolveNotificationRoute } from "./session-route";
import type { PersistedSessionInfo } from "./types";

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
  explicit: boolean;
  skipReason?: string;
}

export interface CompletionSummaryCoordinatorOptions {
  maxCompletedKeys?: number;
}

const DEFAULT_MAX_COMPLETED_KEYS = 1024;
const DUPLICATE_REASON = "duplicate completion follow-up wake already handled";

export class CompletionSummaryCoordinator {
  private readonly inFlight = new Set<string>();
  private readonly completed = new Map<string, true>();
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
  ): CompletionSummaryDecision {
    if (fact?.required !== true) {
      return { required: false, allowed: false, explicit: false };
    }

    const key = this.buildKey(session, fact);
    if (!key) {
      return { required: true, allowed: true, explicit: false };
    }

    if (this.inFlight.has(key.key) || this.completed.has(key.key)) {
      return {
        required: true,
        allowed: false,
        key: key.key,
        explicit: key.explicit,
        skipReason: DUPLICATE_REASON,
      };
    }

    this.inFlight.add(key.key);
    return {
      required: true,
      allowed: true,
      key: key.key,
      explicit: key.explicit,
    };
  }

  finish(key: string | undefined, completed: boolean): void {
    if (!key) return;
    this.inFlight.delete(key);
    if (!completed) return;

    this.completed.delete(key);
    this.completed.set(key, true);
    while (this.completed.size > this.maxCompletedKeys) {
      const oldestKey = this.completed.keys().next().value;
      if (oldestKey === undefined) break;
      this.completed.delete(oldestKey);
    }
  }

  private buildKey(
    session: CompletionSummarySession | PersistedCompletionSummarySession,
    fact: CompletionSummaryFact,
  ): { key: string; explicit: boolean } | undefined {
    const deliveryRef = this.getDeliveryRef(session);
    if (!deliveryRef) return undefined;

    const outcomeKey = this.normalizeOutcomeKey(session, fact.outcomeKey?.trim());
    if (outcomeKey) {
      return {
        key: `${this.buildVisibleScope(deliveryRef, session)}:outcome:${this.digest(outcomeKey)}`,
        explicit: true,
      };
    }

    const fingerprint = fact.fallbackFingerprint?.trim();
    if (!fingerprint) return undefined;
    return {
      key: `${deliveryRef}:${fact.producer}:${this.digest(fingerprint)}`,
      explicit: false,
    };
  }

  private normalizeOutcomeKey(
    session: CompletionSummarySession | PersistedCompletionSummarySession,
    outcomeKey: string | undefined,
  ): string | undefined {
    const goalTaskId = session.goalTaskId?.trim();
    if (goalTaskId) return `goal:${goalTaskId}`;
    return outcomeKey;
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

  private getDeliveryRef(session: CompletionSummarySession | PersistedCompletionSummarySession): string {
    return getPrimarySessionLookupRef(session) ?? getBackendConversationId(session) ?? "";
  }

  private digest(value: string): string {
    return createHash("sha256").update(value).digest("hex").slice(0, 16);
  }
}
