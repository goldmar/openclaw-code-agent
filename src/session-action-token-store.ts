import { randomUUID } from "crypto";
import type { SessionActionKind, SessionActionToken } from "./types";

function isPlanDecisionKind(kind: SessionActionKind): boolean {
  return kind === "plan-approve" || kind === "plan-request-changes" || kind === "plan-reject";
}

/**
 * Token-only persistence layer for interactive callbacks.
 * SessionStore composes this into the shared index file without mixing token
 * CRUD and session CRUD logic in one class.
 */
/**
 * Hooks into the persisted index. `sync` reloads changes another writer made to
 * the index (cheap when nothing changed); `onMiss` reports a lookup miss after
 * that reload for diagnostics.
 */
export type SessionActionTokenStoreDiskHooks = {
  sync: (reason: string) => void;
  onMiss?: (details: { reason: string }) => void;
};

export class SessionActionTokenStore {
  readonly tokens: Map<string, SessionActionToken> = new Map();
  /** Tokens adopted from the persisted index after load (minted by another writer). */
  readonly adoptedTokenIds: Set<string> = new Set();
  private afterChange?: () => void;
  private diskHooks?: SessionActionTokenStoreDiskHooks;

  constructor(
    private readonly onChange: () => void,
    private readonly retentionMs: number,
  ) {}

  setDiskHooks(hooks: SessionActionTokenStoreDiskHooks | undefined): void {
    this.diskHooks = hooks;
  }

  private syncFromDisk(reason: string): void {
    this.diskHooks?.sync(reason);
  }

  isAdopted(tokenId: string): boolean {
    return this.adoptedTokenIds.has(tokenId);
  }

  replaceAll(tokens: Iterable<SessionActionToken>): void {
    this.tokens.clear();
    this.adoptedTokenIds.clear();
    for (const token of tokens) {
      this.tokens.set(token.id, token);
    }
  }

  clear(): void {
    this.tokens.clear();
    this.adoptedTokenIds.clear();
    this.notifyChanged();
  }

  listForPersistence(): SessionActionToken[] {
    return [...this.tokens.values()];
  }

  createActionToken(
    sessionId: string,
    kind: SessionActionKind,
    options: Partial<Omit<SessionActionToken, "id" | "sessionId" | "kind" | "createdAt">> = {},
  ): SessionActionToken {
    const token: SessionActionToken = {
      id: randomUUID(),
      sessionId,
      kind,
      createdAt: Date.now(),
      ...options,
    };
    this.tokens.set(token.id, token);
    this.notifyChanged();
    return token;
  }

  /**
   * Look a token up after re-reading the persisted index when another writer
   * changed it, so a button minted elsewhere is not reported as stale and a
   * token consumed elsewhere is seen as consumed.
   */
  getActionToken(tokenId: string): SessionActionToken | undefined {
    if (this.diskHooks) {
      // Also for a cached token: another writer may have consumed it.
      this.syncFromDisk("token-lookup");
      if (!this.tokens.has(tokenId)) this.diskHooks.onMiss?.({ reason: "token-miss" });
    }
    return this.peekActionToken(tokenId);
  }

  private peekActionToken(tokenId: string): SessionActionToken | undefined {
    const token = this.tokens.get(tokenId);
    if (!token) return undefined;
    if (token.expiresAt != null && token.expiresAt <= Date.now()) {
      this.tokens.delete(tokenId);
      this.adoptedTokenIds.delete(tokenId);
      this.notifyChanged();
      return undefined;
    }
    return token;
  }

  listActiveActionTokens(kind?: SessionActionKind): SessionActionToken[] {
    this.syncFromDisk("token-list");
    const result: SessionActionToken[] = [];
    for (const tokenId of [...this.tokens.keys()]) {
      const token = this.peekActionToken(tokenId);
      if (!token || token.consumedAt != null) continue;
      if (kind && token.kind !== kind) continue;
      result.push(token);
    }
    return result;
  }

  consumeActionToken(tokenId: string): SessionActionToken | undefined {
    // Pick up a consumption another writer already persisted before consuming here.
    this.syncFromDisk("token-consume");
    const token = this.getActionToken(tokenId);
    if (!token || token.consumedAt != null) return undefined;
    token.consumedAt = Date.now();
    token.consumptionId = randomUUID();
    this.notifyChanged();
    return token;
  }

  /**
   * Whether the consumption `consumptionId` of this token is still the one this
   * store holds. Call it once the consumption is persisted: when another writer
   * of the index persisted a consumption of the same token first, the merge
   * adopted that one and this click must not act.
   */
  confirmActionTokenConsumption(tokenId: string, consumptionId: string | undefined): boolean {
    // Bulk consumptions (question and plan tokens) carry no id; their callbacks
    // are serialized per session in-process instead.
    if (!consumptionId) return true;
    const token = this.tokens.get(tokenId);
    return !token || token.consumptionId === undefined || token.consumptionId === consumptionId;
  }

  consumeQuestionAnswerTokens(sessionId: string, requestId: string, questionId?: string): SessionActionToken[] {
    this.syncFromDisk("token-consume");
    const consumed: SessionActionToken[] = [];
    const consumedAt = Date.now();
    for (const token of this.tokens.values()) {
      if (
        token.sessionId !== sessionId
        || token.kind !== "question-answer"
        || token.pendingInputRequestId !== requestId
        || (questionId != null && token.pendingInputQuestionId !== questionId)
        || token.consumedAt != null
      ) continue;
      token.consumedAt = consumedAt;
      consumed.push(token);
    }
    if (consumed.length > 0) this.notifyChanged();
    return consumed;
  }

  consumePlanDecisionTokens(sessionId: string, planDecisionVersion: number): SessionActionToken[] {
    this.syncFromDisk("token-consume");
    const consumed: SessionActionToken[] = [];
    const consumedAt = Date.now();
    for (const token of this.tokens.values()) {
      if (
        token.sessionId !== sessionId
        || !isPlanDecisionKind(token.kind)
        || token.planDecisionVersion !== planDecisionVersion
        || token.consumedAt != null
      ) continue;
      token.consumedAt = consumedAt;
      consumed.push(token);
    }
    if (consumed.length > 0) this.notifyChanged();
    return consumed;
  }

  deleteActionTokensForSession(sessionId: string): void {
    let changed = false;
    for (const [tokenId, token] of this.tokens) {
      if (token.sessionId === sessionId) {
        this.tokens.delete(tokenId);
        this.adoptedTokenIds.delete(tokenId);
        changed = true;
      }
    }
    if (changed) this.notifyChanged();
  }

  deleteActionTokensForSessionByKind(sessionId: string, kind: SessionActionKind): void {
    let changed = false;
    for (const [tokenId, token] of this.tokens) {
      if (token.sessionId === sessionId && token.kind === kind) {
        this.tokens.delete(tokenId);
        this.adoptedTokenIds.delete(tokenId);
        changed = true;
      }
    }
    if (changed) this.notifyChanged();
  }

  deletePlanDecisionTokensForSession(sessionId: string, keepVersion?: number): void {
    let changed = false;
    for (const [tokenId, token] of this.tokens) {
      if (token.sessionId !== sessionId || !isPlanDecisionKind(token.kind)) continue;
      if (keepVersion != null && token.planDecisionVersion === keepVersion) continue;
      this.tokens.delete(tokenId);
      this.adoptedTokenIds.delete(tokenId);
      changed = true;
    }
    if (changed) this.notifyChanged();
  }

  purgeExpiredActionTokens(now: number = Date.now()): boolean {
    let changed = false;
    for (const [tokenId, token] of this.tokens) {
      const expired = token.expiresAt != null && token.expiresAt <= now;
      const consumedTooOld = token.consumedAt != null && now - token.consumedAt >= this.retentionMs;
      if (expired || consumedTooOld) {
        this.tokens.delete(tokenId);
        this.adoptedTokenIds.delete(tokenId);
        changed = true;
      }
    }
    if (changed) this.notifyChanged();
    return changed;
  }

  nextExpiryAt(): number | undefined {
    let nextExpiryAt: number | undefined;
    for (const token of this.tokens.values()) {
      const candidates = [
        token.expiresAt,
        token.consumedAt != null ? token.consumedAt + this.retentionMs : undefined,
      ].filter((value): value is number => value != null && Number.isFinite(value));

      for (const candidate of candidates) {
        if (nextExpiryAt == null || candidate < nextExpiryAt) {
          nextExpiryAt = candidate;
        }
      }
    }
    return nextExpiryAt;
  }

  setAfterChangeListener(listener: (() => void) | undefined): void {
    this.afterChange = listener;
  }

  private notifyChanged(): void {
    this.onChange();
    this.afterChange?.();
  }
}
