import "./test-env";
import { after, afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { createCallbackHandler } from "../src/callback-handler";
import { SessionActionTokenStore } from "../src/session-action-token-store";
import { setAutoUpdateService, setSessionManager } from "../src/singletons";
import type { SessionManager } from "../src/session-manager";
import type { makeAgentMergeTool } from "../src/tools/agent-merge";
import type { makeAgentPrTool } from "../src/tools/agent-pr";
import { propertyParams } from "./property-harness";

/**
 * Model-based tests for the button lifecycle: a real SessionActionTokenStore
 * behind the real callback handler, driven by random mint / click /
 * double-click / expire / consume / purge / delete / settle sequences.
 *
 * Invariants:
 * - a click acts only on a live token (minted, not consumed, not expired, not
 *   deleted), and each token acts at most once;
 * - a worktree button never acts on a settled worktree decision (merged or
 *   discarded), and two concurrent clicks on one worktree run at most one
 *   worktree action;
 * - the store's active tokens are exactly the model's live tokens.
 */

const SESSIONS = ["sess-a", "sess-b"] as const;
const WORKTREE_KINDS = ["worktree-merge", "worktree-create-pr", "worktree-decide-later", "worktree-dismiss"] as const;
const OTHER_KINDS = ["plan-offer-dismiss", "plugin-update-dismiss"] as const;
type Kind = typeof WORKTREE_KINDS[number] | typeof OTHER_KINDS[number];
const isWorktreeKind = (kind: Kind): boolean => (WORKTREE_KINDS as readonly string[]).includes(kind);
const RETENTION_MS = 60_000;

type TokenModel = {
  id: string;
  sessionId: string;
  kind: Kind;
  expiresAt?: number;
  consumed: boolean;
  deleted: boolean;
  acted: number;
};

type Model = {
  tokens: TokenModel[];
  settled: Map<string, "merged" | "discarded">;
};

type Action = { sessionId: string; kind: Kind };

type Real = {
  store: SessionActionTokenStore;
  actions: Action[];
  /** Outcome of the next worktree tool/action per session (true = success). */
  nextOutcome: Map<string, boolean>;
  persisted: Map<string, { name: string; worktreeMerged?: boolean; worktreeDismissedAt?: string }>;
  handler: ReturnType<typeof createCallbackHandler>["handler"];
};

let clock = 1_000_000;

function isLive(token: TokenModel): boolean {
  return !token.deleted && !token.consumed && !(token.expiresAt !== undefined && token.expiresAt <= clock);
}

type Ctx = Parameters<Real["handler"]>[0];

function buildCtx(payload: string, channel: "telegram" | "discord", replies: string[]): Ctx {
  const respond = channel === "telegram"
    ? {
        acknowledge: async (): Promise<void> => {},
        reply: async ({ text }: { text: string }): Promise<void> => { replies.push(text); },
        clearButtons: async (): Promise<void> => {},
        editButtons: async (): Promise<void> => {},
        editMessage: async (): Promise<void> => {},
      }
    : {
        acknowledge: async (): Promise<void> => {},
        reply: async ({ text }: { text: string }): Promise<void> => { replies.push(text); },
        followUp: async ({ text }: { text: string }): Promise<void> => { replies.push(text); },
        editMessage: async (): Promise<void> => {},
        clearComponents: async (): Promise<void> => {},
      };
  const ctx = channel === "telegram"
    ? {
        channel,
        accountId: "bot",
        callbackId: `callback-${payload}`,
        conversationId: "-1001234567890",
        senderId: "12345",
        isGroup: true,
        isForum: false,
        auth: { isAuthorizedSender: true },
        callback: { data: `code-agent:${payload}`, namespace: "code-agent", payload, messageId: 1, chatId: "-1001234567890", messageText: "prompt" },
        respond,
      }
    : { channel, auth: { isAuthorizedSender: true }, interaction: { payload }, respond };
  // The SDK context types carry many members the handler never reads.
  return ctx as unknown as Ctx;
}

function createReal(): Real {
  const store = new SessionActionTokenStore(() => {}, RETENTION_MS);
  const actions: Action[] = [];
  const nextOutcome = new Map<string, boolean>();
  const persisted = new Map<string, { name: string; worktreeMerged?: boolean; worktreeDismissedAt?: string }>(
    SESSIONS.map((id) => [id, { name: `${id}-name` }]),
  );
  const outcome = (sessionId: string): boolean => nextOutcome.get(sessionId) ?? true;

  // Only the members the callback handler calls for these action kinds.
  const manager = {
    getActionToken: (id: string) => store.getActionToken(id),
    consumeActionToken: (id: string) => store.consumeActionToken(id),
    isAdoptedActionToken: (id: string) => store.isAdopted(id),
    resolve: (): undefined => undefined,
    getPersistedSession: (id: string) => persisted.get(id),
    whenStorePersisted: async (): Promise<void> => {},
    snoozeWorktreeDecision: (sessionId: string): string => {
      actions.push({ sessionId, kind: "worktree-decide-later" });
      return outcome(sessionId) ? "Snoozed." : "❌ Snooze failed.";
    },
    dismissWorktree: async (sessionId: string): Promise<string> => {
      await Promise.resolve();
      actions.push({ sessionId, kind: "worktree-dismiss" });
      if (!outcome(sessionId)) return "❌ Discard failed.";
      persisted.get(sessionId)!.worktreeDismissedAt = new Date(clock).toISOString();
      return "Discarded.";
    },
  };
  setSessionManager(manager as unknown as SessionManager);

  const toolResult = (success: boolean) => ({ content: [{ type: "text", text: success ? "✅ done" : "❌ failed" }], meta: { success } });
  const mergeTool = (() => ({
    execute: async (_id: string, params: { session: string }) => {
      await Promise.resolve();
      actions.push({ sessionId: params.session, kind: "worktree-merge" });
      const success = outcome(params.session);
      if (success) persisted.get(params.session)!.worktreeMerged = true;
      return toolResult(success);
    },
  })) as unknown as typeof makeAgentMergeTool;
  const prTool = (() => ({
    execute: async (_id: string, params: { session: string }) => {
      await Promise.resolve();
      actions.push({ sessionId: params.session, kind: "worktree-create-pr" });
      return toolResult(outcome(params.session));
    },
  })) as unknown as typeof makeAgentPrTool;

  // plan-offer-dismiss and plugin-update-dismiss act by replying; count those replies.
  const handler = createCallbackHandler("telegram", { makeAgentMergeTool: mergeTool, makeAgentPrTool: prTool }).handler;
  return { store, actions, nextOutcome, persisted, handler };
}

/** Replies that mean a non-worktree token acted. */
function nonWorktreeActions(replies: string[]): number {
  return replies.filter((text) => text === "✅ Dismissed." || text.startsWith("✅ Skipped this update")).length;
}

function assertStoreMatchesModel(model: Model, real: Real): void {
  const active = new Set(real.store.listActiveActionTokens().map((token) => token.id));
  const live = new Set(model.tokens.filter(isLive).map((token) => token.id));
  assert.deepEqual([...active].sort(), [...live].sort(), "store active tokens differ from the model");
}

type Command = fc.AsyncCommand<Model, Real>;

class Mint implements Command {
  constructor(readonly session: number, readonly kind: Kind, readonly ttl: number | undefined) {}
  check(): boolean { return true; }
  async run(model: Model, real: Real): Promise<void> {
    const sessionId = SESSIONS[this.session];
    const expiresAt = this.ttl === undefined ? undefined : clock + this.ttl;
    const token = real.store.createActionToken(sessionId, this.kind, expiresAt === undefined ? {} : { expiresAt });
    model.tokens.push({ id: token.id, sessionId, kind: this.kind, expiresAt, consumed: false, deleted: false, acted: 0 });
    assertStoreMatchesModel(model, real);
  }
  toString(): string { return `mint(${SESSIONS[this.session]},${this.kind},ttl=${this.ttl ?? "none"})`; }
}

class Advance implements Command {
  constructor(readonly ms: number) {}
  check(): boolean { return true; }
  async run(model: Model, real: Real): Promise<void> {
    clock += this.ms;
    assertStoreMatchesModel(model, real);
  }
  toString(): string { return `advance(${this.ms})`; }
}

async function click(model: Model, real: Real, ref: number | string, channel: "telegram" | "discord", outcome: boolean): Promise<{ token?: TokenModel; wasLive: boolean; settledBefore?: string; replies: string[] }> {
  const token = typeof ref === "number" ? model.tokens[ref % model.tokens.length] : undefined;
  const payload = token?.id ?? String(ref);
  if (token) real.nextOutcome.set(token.sessionId, outcome);
  const wasLive = token ? isLive(token) : false;
  const settledBefore = token ? model.settled.get(token.sessionId) : undefined;
  const replies: string[] = [];
  const result = await real.handler(buildCtx(payload, channel, replies));
  assert.deepEqual(result, { handled: true });
  return { token, wasLive, settledBefore, replies };
}

/** Update the model after a click whose token was live, given the actions it ran. */
function applyClick(model: Model, token: TokenModel | undefined, wasLive: boolean, settledBefore: string | undefined, actionsRun: Action[], replies: string[], outcome: boolean, label: string): void {
  const acted = actionsRun.length + nonWorktreeActions(replies);
  assert.ok(acted <= 1, `${label}: one click ran ${acted} actions`);
  if (!token || !wasLive) {
    assert.equal(acted, 0, `${label}: a stale or unknown token acted`);
    assert.ok(replies.length === 1 && /stale|Unrecognized|not recognized|expired|already answered|no longer|already resolved/i.test(replies[0]), `${label}: ${JSON.stringify(replies)}`);
    return;
  }
  // A live token is consumed by the click, whether or not the action succeeds.
  token.consumed = true;
  if (isWorktreeKind(token.kind) && settledBefore) {
    assert.equal(acted, 0, `${label}: acted on a worktree decision already ${settledBefore}`);
    assert.ok(replies.some((text) => text.includes(`already resolved (${settledBefore})`)), `${label}: ${JSON.stringify(replies)}`);
    return;
  }
  assert.equal(acted, 1, `${label}: a live token did not act`);
  token.acted += 1;
  assert.equal(token.acted, 1, `${label}: token acted twice`);
  if (actionsRun.length === 1) {
    assert.deepEqual(actionsRun[0], { sessionId: token.sessionId, kind: token.kind });
    if (outcome && token.kind === "worktree-merge") model.settled.set(token.sessionId, "merged");
    if (outcome && token.kind === "worktree-dismiss") model.settled.set(token.sessionId, "discarded");
  }
}

class Click implements Command {
  constructor(readonly ref: number | string, readonly channel: "telegram" | "discord", readonly outcome: boolean) {}
  check(model: Readonly<Model>): boolean { return typeof this.ref === "string" || model.tokens.length > 0; }
  async run(model: Model, real: Real): Promise<void> {
    const before = real.actions.length;
    const { token, wasLive, settledBefore, replies } = await click(model, real, this.ref, this.channel, this.outcome);
    applyClick(model, token, wasLive, settledBefore, real.actions.slice(before), replies, this.outcome, this.toString());
    assertStoreMatchesModel(model, real);
  }
  toString(): string { return `click(${typeof this.ref === "number" ? `#${this.ref}` : JSON.stringify(this.ref)},${this.channel},${this.outcome ? "ok" : "fail"})`; }
}

/** Two clicks delivered concurrently (a double tap, or two users on one prompt). */
class DoubleClick implements Command {
  constructor(readonly first: number, readonly second: number) {}
  check(model: Readonly<Model>): boolean { return model.tokens.length > 0; }
  async run(model: Model, real: Real): Promise<void> {
    const tokens = [model.tokens[this.first % model.tokens.length], model.tokens[this.second % model.tokens.length]];
    const liveBefore = tokens.map(isLive);
    const settledBefore = new Map(SESSIONS.map((id) => [id, model.settled.get(id)]));
    const before = real.actions.length;
    const repliesA: string[] = [];
    const repliesB: string[] = [];
    await Promise.all([
      real.handler(buildCtx(tokens[0].id, "telegram", repliesA)),
      real.handler(buildCtx(tokens[1].id, "discord", repliesB)),
    ]);
    const actions = real.actions.slice(before);
    const replyActions = nonWorktreeActions([...repliesA, ...repliesB]);
    const distinctLive = new Set(tokens.filter((_token, index) => liveBefore[index]).map((token) => token.id)).size;
    assert.ok(actions.length + replyActions <= distinctLive, `${this.toString()}: ${actions.length + replyActions} actions for ${distinctLive} live tokens`);
    for (const sessionId of SESSIONS) {
      const worktreeActions = actions.filter((action) => action.sessionId === sessionId);
      assert.ok(worktreeActions.length <= 1, `${this.toString()}: concurrent worktree actions on ${sessionId}`);
      if (worktreeActions.length > 0) assert.equal(settledBefore.get(sessionId), undefined, `${this.toString()}: acted on a settled worktree`);
    }
    // Every live token that was clicked is consumed unless the worktree lock
    // turned its click away; read that back from the store.
    const active = new Set(real.store.listActiveActionTokens().map((token) => token.id));
    for (const [index, token] of tokens.entries()) {
      if (liveBefore[index] && !active.has(token.id)) token.consumed = true;
    }
    for (const action of actions) {
      const token = tokens.find((candidate) => candidate.sessionId === action.sessionId && candidate.kind === action.kind);
      assert.ok(token, "an action ran for a token that was not clicked");
      token.acted += 1;
      assert.equal(token.acted, 1, `${this.toString()}: token acted twice`);
      if (real.persisted.get(action.sessionId)?.worktreeMerged) model.settled.set(action.sessionId, "merged");
      if (real.persisted.get(action.sessionId)?.worktreeDismissedAt) model.settled.set(action.sessionId, "discarded");
    }
    assertStoreMatchesModel(model, real);
  }
  toString(): string { return `doubleClick(#${this.first},#${this.second})`; }
}

class ExternalConsume implements Command {
  constructor(readonly ref: number) {}
  check(model: Readonly<Model>): boolean { return model.tokens.length > 0; }
  async run(model: Model, real: Real): Promise<void> {
    const token = model.tokens[this.ref % model.tokens.length];
    const consumed = real.store.consumeActionToken(token.id);
    assert.equal(Boolean(consumed), isLive(token), "consume succeeds exactly for live tokens");
    token.consumed = true;
    assertStoreMatchesModel(model, real);
  }
  toString(): string { return `consume(#${this.ref})`; }
}

class Purge implements Command {
  check(): boolean { return true; }
  async run(model: Model, real: Real): Promise<void> {
    real.store.purgeExpiredActionTokens(clock);
    for (const token of model.tokens) {
      if (token.expiresAt !== undefined && token.expiresAt <= clock) token.deleted = true;
    }
    assertStoreMatchesModel(model, real);
  }
  toString(): string { return "purge"; }
}

class DeleteSessionTokens implements Command {
  constructor(readonly session: number) {}
  check(): boolean { return true; }
  async run(model: Model, real: Real): Promise<void> {
    const sessionId = SESSIONS[this.session];
    real.store.deleteActionTokensForSession(sessionId);
    for (const token of model.tokens) if (token.sessionId === sessionId) token.deleted = true;
    assertStoreMatchesModel(model, real);
  }
  toString(): string { return `deleteTokens(${SESSIONS[this.session]})`; }
}

/** The worktree is settled another way (agent_merge tool, dismiss command, or another runtime). */
class SettleElsewhere implements Command {
  constructor(readonly session: number, readonly how: "merged" | "discarded") {}
  check(model: Readonly<Model>): boolean { return !model.settled.has(SESSIONS[this.session]); }
  async run(model: Model, real: Real): Promise<void> {
    const sessionId = SESSIONS[this.session];
    const row = real.persisted.get(sessionId)!;
    if (this.how === "merged") row.worktreeMerged = true;
    else row.worktreeDismissedAt = new Date(clock).toISOString();
    model.settled.set(sessionId, this.how);
  }
  toString(): string { return `settleElsewhere(${SESSIONS[this.session]},${this.how})`; }
}

const sessionIndexArb = fc.nat({ max: SESSIONS.length - 1 });
const commandArbs: fc.Arbitrary<Command>[] = [
  fc.tuple(sessionIndexArb, fc.constantFrom<Kind>(...WORKTREE_KINDS, ...OTHER_KINDS), fc.option(fc.integer({ min: 1, max: 5_000 }), { nil: undefined }))
    .map(([session, kind, ttl]) => new Mint(session, kind, ttl)),
  fc.integer({ min: 1, max: 4_000 }).map((ms) => new Advance(ms)),
  fc.tuple(fc.oneof({ weight: 5, arbitrary: fc.nat({ max: 20 }) }, { weight: 1, arbitrary: fc.oneof(fc.string({ maxLength: 12 }), fc.uuid()) }), fc.constantFrom<"telegram" | "discord">("telegram", "discord"), fc.boolean())
    .map(([ref, channel, outcome]) => new Click(ref, channel, outcome)),
  fc.tuple(fc.nat({ max: 20 }), fc.nat({ max: 20 })).map(([first, second]) => new DoubleClick(first, second)),
  fc.nat({ max: 20 }).map((ref) => new ExternalConsume(ref)),
  fc.constant(new Purge()),
  sessionIndexArb.map((session) => new DeleteSessionTokens(session)),
  fc.tuple(sessionIndexArb, fc.constantFrom<"merged" | "discarded">("merged", "discarded")).map(([session, how]) => new SettleElsewhere(session, how)),
];

describe("action tokens and worktree decisions (model-based)", () => {
  before(() => {
    mock.method(Date, "now", () => clock);
    setAutoUpdateService(null);
  });
  after(() => mock.restoreAll());
  afterEach(() => setSessionManager(null));

  it("acts at most once per live token and never on a settled worktree", async () => {
    await fc.assert(
      fc.asyncProperty(fc.commands(commandArbs, { maxCommands: 35 }), async (commands) => {
        clock = 1_000_000;
        const real = createReal();
        const model: Model = { tokens: [], settled: new Map() };
        await fc.asyncModelRun(() => ({ model, real }), commands);
      }),
      propertyParams(120),
    );
  });

  it("rejects a token that expires between mint and click", async () => {
    clock = 5_000;
    const real = createReal();
    const token = real.store.createActionToken("sess-a", "worktree-merge", { expiresAt: clock + 10 });
    clock += 10;
    const replies: string[] = [];
    await real.handler(buildCtx(token.id, "telegram", replies));
    assert.deepEqual(real.actions, []);
    assert.deepEqual(replies, ["⚠️ This button has expired or was already used."]);
  });
});
