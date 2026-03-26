# Codex Auth Race Fix Plan

> Historical implementation plan. This is an internal design record, not part of the main user-facing docs surface.

## Summary

### What I verified

- `openclaw-code-agent` uses `@openai/codex-sdk@0.107.0` and `@anthropic-ai/claude-agent-sdk@0.2.37`.
- The Codex harness currently constructs the SDK with `new Codex()` in [`src/harness/codex.ts`](../../src/harness/codex.ts), so every Codex turn inherits the plugin process environment and therefore the shared `~/.codex` tree.
- The installed Codex SDK is a thin wrapper around the `codex` CLI. In `node_modules/@openai/codex-sdk/dist/index.js`, `new Codex({ env })` is supported and passed directly to the spawned CLI process.
- The SDK exposes no auth-path override, no refresh-disable option, and no hook around token refresh.
- The shipped Codex CLI help exposes `--config` and `--ephemeral`, but not `--no-refresh`, not a config-dir flag, and nothing equivalent to `CODEX_CONFIG_DIR`.
- Current `~/.codex/auth.json` shape matches the reported structure:
  - top-level keys: `OPENAI_API_KEY`, `auth_mode`, `last_refresh`, `tokens`
  - `auth_mode` is `chatgpt`
  - `tokens` contains `access_token`, `account_id`, `id_token`, `refresh_token`
- The plugin already avoids reusing persisted Codex thread IDs after restart in [`src/resume-policy.ts:20-52`](../../src/resume-policy.ts), because Codex resume state is brittle across restarts/auth changes.
- The OpenClaw `acpx` plugin spawns backend processes with inherited `process.env` in `/home/openclaw/openclaw/extensions/acpx/src/runtime-internals/process.ts:125-154`; it does not override `HOME`.
- `acpx` defaults to a Codex-backed agent path for `codex` sessions via `/home/openclaw/openclaw/extensions/acpx/src/runtime-internals/mcp-agent-command.ts:6`, and its runtime launches those sessions through `/home/openclaw/openclaw/extensions/acpx/src/runtime.ts:282-360` and `/home/openclaw/openclaw/extensions/acpx/src/runtime.ts:702-720`.

### Recommendation

Implement a **hybrid of Option A and Option B**:

- **Primary mechanism:** per-session isolated `HOME` for Codex child processes
- **Plus:** a narrow global startup lock around each Codex CLI turn bootstrap, only until the first streamed event or startup failure

This is the only approach that addresses both halves of the failure:

- isolated `HOME` prevents shared `~/.codex/auth.json` corruption
- startup serialization prevents multiple sessions from attempting the same refresh token rotation at the same time

I do **not** recommend:

- **Option A alone**: it prevents global file corruption, but concurrent sessions can still all copy the same stale refresh token and lose with `refresh_token_reused`
- **Option B alone**: the SDK refresh happens inside the CLI child process; locking only around `new Codex()` or `startThread()` does not control the shared auth file unless we also isolate the child environment
- **Option C as the main fix**: it is technically possible to add a pre-refresh coordinator, but without a supported “skip refresh inside session” control it is extra cost/latency and still incomplete
- **Option D**: only reduces probability, does not fix correctness

## Why The Hybrid Works

Each `runStreamed()` call in the SDK spawns a fresh `codex exec` process. That means auth checks and refreshes can happen **every turn bootstrap**, not only once when the harness is created.

The safe sequence is:

1. Acquire a global auth bootstrap lock.
2. Prepare an isolated temp `HOME` for this harness/session.
3. Copy the latest canonical `auth.json` into the temp home.
4. Start the Codex turn using `new Codex({ env: { HOME: tempHome, ... } })`.
5. Hold the lock only until the child produces its first event, or fails before producing one.
6. Sync a newer temp `auth.json` back to canonical under the same lock.
7. Release the lock.
8. Let the turn continue normally without blocking other sessions.

This keeps concurrency high after startup while ensuring only one process can perform a refresh from a given canonical token state.

## Design

### Canonical vs isolated `.codex`

Use a temp home per live Codex harness instance, for example:

```text
/tmp/openclaw-codex-auth/<session-uuid>/home
```

Inside that temp home:

- create `.codex/auth.json` by copying from the canonical home
- symlink `.codex/sessions` to the canonical `~/.codex/sessions`
- symlink `.codex/config.toml` if present

This split is important:

- `auth.json` must be isolated
- `sessions/` should stay shared so `resumeThread(threadId)` still works across new OpenClaw sessions and in-memory Codex resumes
- `config.toml` should remain consistent with the user’s normal Codex settings

### Lock scope

Do **not** lock the entire turn.

Lock only:

- temp-home auth sync from canonical
- child process startup through first event
- sync-back of fresher auth to canonical

That should reduce the contention window to “auth/bootstrap time” instead of the whole agent run.

### Sync-back rule

When syncing temp `auth.json` back to canonical:

- compare parsed `last_refresh`
- only overwrite canonical when temp is newer
- if `last_refresh` is equal, prefer canonical and do nothing
- if temp `auth.json` is unreadable or partial, do nothing
- perform the overwrite atomically: write `auth.json.tmp`, then rename

This should be enough. A more complex token-field merge is not needed unless testing shows `last_refresh` is insufficient.

## Implementation Spec

### Files to modify

#### 1. `src/harness/codex.ts`

Current ranges to touch:

- [`src/harness/codex.ts:6-35`](../../src/harness/codex.ts#L6)
- [`src/harness/codex.ts:147-157`](../../src/harness/codex.ts#L147)
- [`src/harness/codex.ts:173-424`](../../src/harness/codex.ts#L173)

Planned changes:

- replace bare `new Codex()` construction with `new Codex({ env })`
- add a per-harness auth workspace object
- wrap each `runTurn()` bootstrap in the auth lock/bootstrap sequence
- cleanup the temp home in `runSession()` finalization

#### 2. New file: `src/harness/codex-auth.ts`

New helper module to keep the auth isolation logic out of `codex.ts`.

Responsibilities:

- resolve canonical paths (`$HOME/.codex/auth.json`, `sessions`, `config.toml`)
- create and cleanup the temp home
- build the child env override
- acquire/release the global lock
- copy/symlink files into the temp home
- sync newer auth back to canonical atomically

#### 3. `tests/codex-harness.test.ts`

Current ranges likely affected:

- [`tests/codex-harness.test.ts:40-58`](../../tests/codex-harness.test.ts#L40)
- [`tests/codex-harness.test.ts:114-438`](../../tests/codex-harness.test.ts#L114)

Planned changes:

- allow the mock factory to observe `Codex` constructor options, especially `env.HOME`
- add harness-level tests for lock/bootstrap behavior and unchanged turn semantics

#### 4. New file: `tests/codex-auth.test.ts`

New helper-focused tests for file/lock/sync behavior.

### Files audited but not planned for change

#### `src/harness/claude-code.ts`

Audited ranges:

- [`src/harness/claude-code.ts:57-82`](../../src/harness/claude-code.ts#L57)

No fix planned. See Claude audit below.

#### `src/session-manager.ts`

Audited ranges:

- [`src/session-manager.ts:133-174`](../../src/session-manager.ts#L133)
- [`src/session-manager.ts:176-223`](../../src/session-manager.ts#L176)

No change required for the initial fix if `sessions/` remains shared and auth isolation stays self-contained in the Codex harness.

#### `src/resume-policy.ts`

Audited ranges:

- [`src/resume-policy.ts:20-52`](../../src/resume-policy.ts#L20)

No change required. Existing behavior already disables persisted Codex resume after restart.

## Code Sketches

### `src/harness/codex-auth.ts`

```ts
type CodexAuthWorkspace = {
  tempHome: string;
  tempCodexDir: string;
  canonicalHome: string;
  canonicalCodexDir: string;
  canonicalAuthPath: string;
  canonicalSessionsPath: string;
  canonicalConfigPath?: string;
  env: Record<string, string>;
  prepareForTurn(): Promise<() => Promise<void>>;
  cleanup(): Promise<void>;
};

export async function createCodexAuthWorkspace(baseEnv = process.env): Promise<CodexAuthWorkspace> {
  // 1. resolve canonical HOME from parent env
  // 2. create temp home under /tmp/openclaw-codex-auth-*
  // 3. create .codex dir
  // 4. symlink sessions/ and config.toml
  // 5. expose env with HOME=tempHome
  // 6. prepareForTurn() acquires lock, syncs auth.json into temp, and returns a release fn
}
```

### Lock/bootstrap wrapper in `src/harness/codex.ts`

```ts
const authWorkspace = await createCodexAuthWorkspace();

private createCodexClient(env: Record<string, string>): CodexClientLike {
  return this.deps.createCodex?.({ env }) ?? new Codex({ env });
}

const runTurn = async (prompt: string): Promise<void> => {
  const releaseAuthBootstrap = await authWorkspace.prepareForTurn();
  let released = false;

  try {
    if (!codexClient) codexClient = this.createCodexClient(authWorkspace.env);
    const streamed = await activeThread.runStreamed(turnPrompt, { signal });

    for await (const event of streamed.events) {
      if (!released) {
        released = true;
        await releaseAuthBootstrap();
      }
      // existing event handling unchanged
    }
  } catch (err) {
    if (!released) {
      released = true;
      await releaseAuthBootstrap();
    }
    throw err;
  }
};
```

### Sync-back logic

```ts
async function syncTempAuthBackIfNewer(tempAuthPath: string, canonicalAuthPath: string): Promise<void> {
  const temp = await readAuth(tempAuthPath);
  const canonical = await readAuth(canonicalAuthPath);

  if (!temp) return;
  if (!canonical || temp.last_refresh > canonical.last_refresh) {
    await atomicWriteJson(canonicalAuthPath, temp.raw);
  }
}
```

### Simple lock implementation

No native dependency is required. A small lockdir loop is enough:

```ts
async function acquireLock(lockDir: string, timeoutMs = 30_000): Promise<() => Promise<void>> {
  // mkdir lockDir
  // retry with short sleep on EEXIST
  // write pid/ts metadata for debugging
  // release = rm -rf lockDir
}
```

## Option-by-option evaluation

### Option A: HOME isolation per session

**Viable, but only as part of the final fix.**

Pros:

- removes shared writes to `~/.codex/auth.json`
- fully supported by the installed SDK because `new Codex({ env })` controls child env

Cons if used alone:

- does not prevent simultaneous refreshes from the same copied refresh token
- can break `resumeThread()` if `sessions/` is also isolated
- needs canonical sync-back logic so the freshest auth survives after the winning refresh

Conclusion:

- use it, but with shared `sessions/` and a bootstrap lock

### Option B: flock-based serialization

**Partially viable, but not sufficient alone.**

Pros:

- serializing startup is the right idea

Cons:

- the refresh and file writes happen inside the Codex CLI child
- locking around SDK object construction is too early
- locking the shared canonical `auth.json` without isolating temp auth still leaves us exposed to child-process writes into the canonical file

Conclusion:

- use a lock, but pair it with isolated child `HOME`
- implement it inside plugin code as a lockdir helper, not raw `flock`

### Option C: pre-refresh coordinator

**Possible fallback or follow-up, not the recommended primary fix.**

What is viable:

- a “warm auth” preflight turn under a global lock, then launch the real batch

Problems:

- the SDK has no “skip refresh” control afterward
- adds extra API cost and latency
- still would not help if later turns trigger a 401-driven refresh

Conclusion:

- keep as a future optimization/admin command only

### Option D: launch jitter

**Not viable as a fix.**

It lowers collision probability but does not provide correctness.

## Claude Code harness audit

## Result

No analogous fix is warranted right now for the Claude harness.

### Why it does not look affected

- The harness in [`src/harness/claude-code.ts`](../../src/harness/claude-code.ts) calls `query(...)` directly and does not manipulate any shared auth file.
- The Claude SDK surface exposes:
  - `env`
  - `persistSession`
  - `settingSources`
  - auth/account inspection types like `auth_status` and `tokenSource`
- The SDK docs/types show session persistence under `~/.claude/projects/`, but that is per-session transcript state, not a single shared mutable auth token file analogous to `~/.codex/auth.json`.
- I did not find a documented or visible primary-source equivalent of:
  - a shared `auth.json`
  - a refresh-token rotation file write path
  - a `refresh_token_reused`-style failure mode

### Residual risk

The Claude CLI internals are bundled/minified, so this is not a proof that no internal token cache exists. It is a practical audit conclusion:

- there is no evidence in the harness or SDK surface of the same race
- there is no known operational signature matching the Codex failure

### Recommendation for Claude

- no code change now
- if future logs show clustered Claude auth failures, add targeted instrumentation first:
  - capture `auth_status` events if the SDK emits them
  - log whether auth is coming from API key vs token source, without logging secrets

## OpenClaw ACP (`acpx`) audit

## Result

Yes, `acpx` has the same class of race for **Codex-backed ACP sessions**.

### Why

- `acpx` spawns child processes with:
  - `env: childEnv`
  - `childEnv` derived from `process.env`
  - no per-session `HOME` override
- That behavior is in `/home/openclaw/openclaw/extensions/acpx/src/runtime-internals/process.ts:142-154`.
- `stripProviderAuthEnvVars` only removes selected provider API-key env vars. It does not isolate `HOME` or `~/.codex/auth.json`.
- For Codex-backed ACP sessions, the spawned `acpx` backend process will pass its inherited `HOME` to the nested Codex agent process as well.
- Therefore multiple concurrent ACP sessions that target Codex can still converge on the same `~/.codex/auth.json` and hit the same refresh/write race.

### Important nuance

`acpx` does not usually execute the `codex` CLI directly. It executes the `acpx` backend, which then launches the configured agent command. For the built-in `codex` agent, the default mapping is:

```text
codex -> npx @zed-industries/codex-acp
```

That changes the process topology, but not the auth-risk conclusion. The nested Codex agent still inherits `HOME` from the parent `acpx` process.

### Recommendation

Apply the same high-level strategy in `acpx`, but at the **process layer** instead of the SDK layer:

- add Codex-only isolated `HOME` support for spawned `acpx` backend processes
- add a Codex-only bootstrap lock around session/turn launches that can trigger Codex agent startup

### Fix path for `acpx`

#### 1. Add spawn env overrides in `process.ts`

Modify `/home/openclaw/openclaw/extensions/acpx/src/runtime-internals/process.ts` so callers can pass extra env overrides, especially `HOME`.

Current ranges to touch:

- `/home/openclaw/openclaw/extensions/acpx/src/runtime-internals/process.ts:125-154`
- `/home/openclaw/openclaw/extensions/acpx/src/runtime-internals/process.ts:185-212`

Planned change:

- extend `spawnWithResolvedCommand()` and `spawnAndCollect()` params with something like:

```ts
envOverrides?: Record<string, string | undefined>;
```

- merge `envOverrides` after provider-auth stripping

#### 2. Add a Codex auth helper in `acpx`

New file:

- `/home/openclaw/openclaw/extensions/acpx/src/runtime-internals/codex-auth.ts`

Responsibilities:

- same temp-home + lockdir + auth sync-back logic as the code-agent harness plan
- return env overrides for the outer `acpx` child process
- keep `.codex/sessions` shared and isolate only `auth.json`

#### 3. Detect when an ACP session is Codex-backed

Primary detection point:

- `/home/openclaw/openclaw/extensions/acpx/src/runtime.ts:631-699`

Use one of these signals:

- agent name normalizes to `codex`
- resolved agent command resolves to a Codex-backed command, such as `@zed-industries/codex-acp`
- optional explicit config override for additional Codex-backed agent names/commands

For the first implementation, agent-name `codex` plus resolved-command inspection is enough.

#### 4. Apply isolation where it matters

Update `/home/openclaw/openclaw/extensions/acpx/src/runtime.ts`:

- `runTurn()` at `:282-360`
- `runControlCommand()` at `:702-720`

Plan:

- when the target session is Codex-backed, request a Codex auth workspace before spawning
- pass `envOverrides: { HOME: tempHome }` into `spawnWithResolvedCommand()` / `spawnAndCollect()`
- for streaming `runTurn()`, hold the lock until the first parsed event or early process failure
- for short control commands that can bootstrap or resume Codex state, hold the lock for the whole command

The commands that likely need protection are:

- `sessions ensure`
- `sessions new`
- `prompt`
- `status` only if testing shows it can spawn/resume a Codex child

`config show`, `--help`, version checks, and doctor probes do not need Codex auth isolation.

#### 5. Add config surface

Modify `/home/openclaw/openclaw/extensions/acpx/src/config.ts`:

- `:34-59`
- `:121-233`
- `:248-359`

Recommended new config:

```ts
codexAuthStrategy?: "inherit" | "isolated-home";
```

Resolved default:

- start with `inherit` if the acpx team wants conservative rollout
- otherwise `isolated-home` is the technically correct default for Codex-backed agents

This should be scoped to Codex-backed agents only, not all ACP agents.

#### 6. Tests

Modify:

- `/home/openclaw/openclaw/extensions/acpx/src/runtime-internals/process.test.ts`
- `/home/openclaw/openclaw/extensions/acpx/src/runtime.test.ts`
- `/home/openclaw/openclaw/extensions/acpx/src/config.test.ts`

Add coverage for:

- `HOME` override is passed through spawn helpers
- provider-auth stripping still works when env overrides are present
- Codex-backed runtime paths use isolated `HOME`
- non-Codex agents keep inherited `HOME`
- config schema accepts/rejects the new auth strategy field correctly

### What `openclaw-code-agent` can learn from `acpx`

`acpx` already has one pattern worth copying conceptually:

- child-process env shaping is centralized in one process helper instead of being scattered across runtime call sites

That is a good design lesson for the code-agent fix:

- keep auth-home manipulation behind a dedicated helper/module
- keep turn/session logic in the runtime/harness and env mutation in one place

## Test plan

### Unit tests for new auth helper

Add `tests/codex-auth.test.ts` to cover:

- temp home creation
- `auth.json` copied into isolated `.codex`
- `sessions/` symlinked to canonical
- `config.toml` symlinked when present
- sync-back updates canonical only when temp `last_refresh` is newer
- malformed temp auth does not overwrite canonical
- lock waits and releases correctly

### Harness tests

Extend `tests/codex-harness.test.ts` to cover:

- `CodexHarness` passes a `HOME` override to the SDK
- per-turn bootstrap lock is released on first event
- release also happens on startup failure before first event
- existing plan-mode, interrupt, resume, and approval-policy behavior stays unchanged

### Manual verification after implementation

Run:

```bash
npm test
```

Then perform a local concurrency drill:

1. Force a stale token scenario or use an account close to refresh threshold.
2. Launch 5-10 parallel Codex sessions through OpenClaw.
3. Confirm:
   - no shared `~/.codex/auth.json` corruption
   - no immediate “logged out” cascade
   - only brief startup serialization
   - `agent_respond` / live Codex resume still works

### Logging

During rollout, add temporary non-secret debug logs behind an env flag, for example:

- lock wait time
- temp home path
- whether sync-back happened
- old/new `last_refresh` timestamps

Do not log token values.

## New dependencies

Recommended: **none**.

Reason:

- lockdir + atomic rename can be implemented with Node built-ins
- avoids introducing native `flock` bindings or a lockfile package for a narrow use case

If the team strongly prefers a library, `proper-lockfile` would be the fallback choice, but I would start without it.

## Rollback plan

Add a feature flag so the legacy behavior is one env change away if rollout goes poorly.

Recommended flag:

```text
OPENCLAW_CODEX_AUTH_STRATEGY=isolated-home
```

Supported values:

- `isolated-home` (new default after rollout)
- `legacy` (current shared-home behavior)

Rollback steps:

1. Set `OPENCLAW_CODEX_AUTH_STRATEGY=legacy`.
2. Redeploy with `bin/deploy-code-agent.sh`.
3. Restart/reload the plugin process if the host does not hot-reload code. The deploy script itself does not restart by default.
4. Verify Codex sessions launch again under the old mode.

This keeps rollback operationally simple even if the new path has an unexpected resume or lock-regression.

## Deployment notes

- Implementation should stay local only until approved. Do not push to remote without approval.
- After implementation:
  - run `npm test`
  - build/deploy through `bin/deploy-code-agent.sh`
- Because deploy does not restart by default, plan a controlled plugin/service reload if the runtime does not automatically pick up the new bundle.

## Final recommendation

Ship **isolated Codex auth homes plus a narrow per-turn bootstrap lock**, with shared canonical `sessions/` and atomic `auth.json` sync-back.

That gives the best balance of correctness and compatibility:

- fixes the shared-file corruption
- prevents startup refresh collisions
- preserves Codex `resumeThread()` behavior
- avoids SDK patching
- avoids extra dependencies
