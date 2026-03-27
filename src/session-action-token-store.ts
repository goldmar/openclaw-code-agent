import { randomUUID } from "crypto";
import type { SessionActionKind, SessionActionToken } from "./types";

/**
 * Token-only persistence layer for interactive callbacks.
 * SessionStore composes this into the shared index file without mixing token
 * CRUD and session CRUD logic in one class.
 */
export class SessionActionTokenStore {
  readonly tokens: Map<string, SessionActionToken> = new Map();

  constructor(
    private readonly onChange: () => void,
    private readonly retentionMs: number,
  ) {}

  replaceAll(tokens: Iterable<SessionActionToken>): void {
    this.tokens.clear();
    for (const token of tokens) {
      this.tokens.set(token.id, token);
    }
  }

  clear(): void {
    this.tokens.clear();
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
    this.onChange();
    return token;
  }

  getActionToken(tokenId: string): SessionActionToken | undefined {
    const token = this.tokens.get(tokenId);
    if (!token) return undefined;
    if (token.expiresAt != null && token.expiresAt <= Date.now()) {
      this.tokens.delete(tokenId);
      this.onChange();
      return undefined;
    }
    return token;
  }

  consumeActionToken(tokenId: string): SessionActionToken | undefined {
    const token = this.getActionToken(tokenId);
    if (!token || token.consumedAt != null) return undefined;
    token.consumedAt = Date.now();
    this.onChange();
    return token;
  }

  deleteActionTokensForSession(sessionId: string): void {
    let changed = false;
    for (const [tokenId, token] of this.tokens) {
      if (token.sessionId === sessionId) {
        this.tokens.delete(tokenId);
        changed = true;
      }
    }
    if (changed) this.onChange();
  }

  purgeExpiredActionTokens(now: number = Date.now()): void {
    let changed = false;
    for (const [tokenId, token] of this.tokens) {
      const expired = token.expiresAt != null && token.expiresAt <= now;
      const consumedTooOld = token.consumedAt != null && now - token.consumedAt > this.retentionMs;
      if (expired || consumedTooOld) {
        this.tokens.delete(tokenId);
        changed = true;
      }
    }
    if (changed) this.onChange();
  }
}
