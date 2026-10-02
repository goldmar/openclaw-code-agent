import type { SessionManager } from "../src/session-manager";
import { matchesGeneration, type SessionGeneration } from "../src/session-generation";

/** Give minimal tool fixtures the same exact-ID contract as the real manager. */
export function withGenerationMethods<T extends object>(fixture: T): T {
  const manager = fixture as T & Partial<SessionManager>;
  manager.get ??= (id) => {
    const session = manager.resolve?.(id);
    return session?.id === id ? session : undefined;
  };
  manager.listPersistedSessions ??= () => [];
  manager.list ??= () => [];
  manager.getSessionGeneration ??= (generation: SessionGeneration) => {
    const ref = generation.kind === "oca" ? generation.sessionId : generation.storageKey;
    const row = manager.getPersistedSession?.(ref);
    return row && matchesGeneration(row, generation) ? row : undefined;
  };
  manager.updateSessionGeneration ??= (generation, patch, options) => {
    const row = options.persisted ? manager.getSessionGeneration!(generation) : undefined;
    if (options.persisted && !row) return false;
    const active = generation.kind === "oca" ? manager.get!(generation.sessionId) : undefined;
    if (!row && !active) return false;
    const ref = generation.kind === "oca" ? generation.sessionId : generation.storageKey;
    if (row) manager.updatePersistedSession?.(ref, patch);
    else if (active) Object.assign(active, patch);
    return true;
  };
  return fixture;
}
