# OpenClaw Code Agent

[![npm version](https://img.shields.io/npm/v/openclaw-code-agent.svg)](https://www.npmjs.com/package/openclaw-code-agent)
[![npm downloads](https://img.shields.io/npm/dm/openclaw-code-agent.svg)](https://www.npmjs.com/package/openclaw-code-agent)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

`openclaw-code-agent` is the OpenClaw plugin for running Claude Code and Codex as managed background coding sessions from chat. Launch work from Telegram, Discord, or any OpenClaw-supported channel, review the plan before execution, keep the job isolated in its own git worktree, and merge or open a PR without leaving the thread.

- **Plan -> Review -> Execute**. `plan` is the default launch mode, with `ask`, `delegate`, and `approve` deciding how much plan approval autonomy the orchestrator gets.
- **Optional worktree isolation**. New sessions default to `off`; opt into `ask`, `delegate`, `auto-merge`, or `auto-pr` when you want worktree-backed branch isolation and post-run branch handling.
- **State-driven decision UX**. `ask` sends explicit action buttons for **Merge locally**, **Create PR**, **Decide later**, and **Dismiss**. The same action-token model now backs both Telegram and Discord interactive callbacks.
- **Lifecycle-first cleanup**. Worktrees are treated as temporary task sandboxes. The plugin distinguishes `merged` from `released` so different-SHA branches whose content already landed on the base branch can still be cleaned safely.
- **Full session lifecycle**. Suspend, resume, fork, interrupt, and recover sessions across restarts with persisted metadata and output.
- **Explicit goal-task loops**. Opt into verifier-driven repair loops or Ralph-style completion loops when you need iterative autonomous execution toward a specific goal.
- **Real operator visibility**. `agent_sessions`, `agent_output`, and `agent_stats` show status, buffered output, duration, and USD cost.
- **Two harnesses, one control plane**. Claude Code and Codex share the same tools, routing, notification pipeline, and worktree strategy model while each backend uses its own native execution substrate.
- **One continuation primitive**. `agent_respond` is the only way to continue, approve, revise, or redirect an existing session. Forks still go through `agent_launch(..., resume_session_id=..., fork_session=true)`.

Need the version-pinned ACP breakdown? See [docs/ACP-COMPARISON.md](docs/ACP-COMPARISON.md).

## From Prompt To Merged Branch

1. Launch a coding session from chat with `/agent ...` or `agent_launch(...)`.
2. Review the plan in the same thread before anything touches the repo.
3. Let the agent finish in an isolated worktree, then merge or publish the result from chat.

### Explicit Goal Tasks

Goal tasks are an explicit opt-in path for iterative autonomous work. They do not replace the default `agent_launch` flow.

Use the dedicated goal entrypoints:

- `/goal ...`
- `goal_launch(...)`

The plugin does not automatically switch into goal mode just because a freeform prompt contains the words `goal task`.

Use them when you want the plugin to keep looping toward one concrete outcome:

- **Verifier mode** reruns one or more shell checks after each coding turn and keeps iterating until they pass or the iteration budget is exhausted.
- **Ralph mode** keeps resuming the same task until the agent emits an exact completion promise, with optional verifiers run after completion is claimed.

Examples:

```bash
/goal --workdir /repo --verify "npm test" --verify "npm run lint" Fix the failing auth flow
/goal --workdir /repo --mode ralph --completion-promise DONE Ship the draft blog post workflow end to end
goal_launch(goal="Fix the failing auth flow", verifier_commands=["npm test", "npm run lint"], workdir="/repo")
goal_launch(goal="Ship the draft blog post workflow end to end", goal_mode="ralph", completion_promise="DONE", workdir="/repo")
```

Once launched, use `goal_status` / `/goal_status` to inspect progress and `goal_stop` / `/goal_stop` to terminate the loop. Goal-task state is persisted so recoverable loops can resume after a gateway restart.

### Plan First

The differentiator is the plan-review loop. Claude Code and Codex both feed the same review UX now: the plugin receives a structured plan artifact, keeps execution blocked until approval, and resumes the same session with `agent_respond(..., approve=true)`. If the user asks for revisions, the revised submission becomes the new actionable review version for that same session, and `approve=true` resolves against that latest version instead of any stale earlier change-request state.

<img src="assets/ask-readme.gif" alt="Plan review in ask mode with inline approval controls">

*`ask` mode keeps the human in the loop: the plan lands back in the originating thread, and execution only starts after approval.*

### Finish Cleanly

When the task is done, the plugin can leave the branch for review, merge it automatically, or help create a PR. In `ask`, the user gets the same explicit decision buttons in the originating thread. In `delegate`, the orchestrator receives the diff context, may merge if safe, and always escalates PR decisions to the user. Planning artifacts belong in `/tmp/` — the agent will not commit analysis notes to the branch.

<img src="assets/delegate-readme.gif" alt="Delegated worktree flow with autonomous follow-through">

*The main checkout stays clean. The branch lifecycle happens in the worktree, and the chat thread stays current on what was shipped.*

### Worktree Lifecycle

Worktree-backed sessions move through product-facing lifecycle states:

- `active`: sandbox still in use
- `pending decision`: waiting for merge / PR / dismiss follow-through
- `pr_open`: PR exists and the sandbox is being preserved
- `merged`: branch landed by normal git ancestry
- `released`: content is already on the base branch even though branch SHAs differ after rebase, squash, or cherry-pick
- `dismissed`: user intentionally discarded the sandbox
- `no_change`: session finished without a committed delta

For cleanup, use `agent_worktree_cleanup(mode="preview_safe")` to preview what **Clean all safe** would remove, `mode="clean_safe"` to perform that cleanup, and `mode="preview_all"` to review both safe sandboxes and the reasons other worktrees were retained.

## Supported Harnesses

| Harness | Status | Notes |
| --- | --- | --- |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Supported | Native harness via `@anthropic-ai/claude-agent-sdk` |
| [Codex](https://github.com/openai/codex) | Supported | Native harness via Codex App Server over stdio |

Launches and notifications work from Telegram, Discord, or any OpenClaw-supported channel. Telegram and Discord now share the same action-token callback flow for plan approvals, question options, resume/restart, and worktree decisions.

## Quick Start

Install and enable the plugin:

```bash
openclaw plugins install openclaw-code-agent
openclaw plugins enable openclaw-code-agent
openclaw gateway restart
```

This release targets the OpenClaw `v2026.4.8` external plugin contract. `package.json` now carries the plugin API compatibility and build metadata used by modern OpenClaw / ClawHub installs, so keep those fields in sync when bumping the plugin release baseline.

Add a minimal config block under `plugins.entries["openclaw-code-agent"]` in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "openclaw-code-agent": {
        "enabled": true,
        "config": {
          "fallbackChannel": "telegram|my-bot|123456789",
          "planApproval": "ask",
          "defaultWorktreeStrategy": "off",
          "harnesses": {
            "claude-code": {
              "defaultModel": "sonnet",
              "allowedModels": ["sonnet", "opus"]
            },
            "codex": {
              "defaultModel": "gpt-5.4",
              "allowedModels": ["gpt-5.4"],
              "reasoningEffort": "medium"
            }
          }
        }
      }
    }
  }
}
```

If you run Codex sessions, keep Codex on the ChatGPT auth path:

```toml
forced_login_method = "chatgpt"
```

Put that in `~/.codex/config.toml`.

Codex approval behavior is fixed to the supported execution path, and OpenClaw handles review gates through `permissionMode` plus `planApproval`.

Launch a first session:

```bash
/agent --name fix-auth Fix the auth middleware bug
/agent_sessions
/agent_respond fix-auth Add unit tests too
agent_launch(prompt="<new task>", resume_session_id="fix-auth", fork_session=true)
```

For multi-workspace or multi-bot setups, configure `agentChannels`. The full routing rules, config matrix, and notification behavior live in [docs/REFERENCE.md](docs/REFERENCE.md).

Prefer fully routable channel strings such as `telegram|123456789` or `telegram|my-bot|123456789`. A bare provider like `telegram` is only a weak fallback; the plugin now repairs topic routing from `originSessionKey` when possible, but explicit channels are still the safer default.

### Upgrade Note For 3.1.0

`3.1.0` is a maintenance release focused on reliability, explicit session state, and release-tooling hardening.

- Upgrading archives old or invalid persisted session stores to a timestamped `.legacy-*.json` backup and starts with a fresh index.
- Legacy Codex SDK session entries are archived and not loaded by the App Server backend.
- App Server-backed Codex sessions are now the only supported Codex runtime path.
- The package now advertises OpenClaw external-plugin compatibility metadata for the `v2026.4.8` plugin API baseline.
- Contributors and release automation should use `pnpm verify` as the canonical validation gate.

### Backend Capabilities

- Claude Code stays on plugin-managed worktrees.
- Codex now runs through App Server structured events and may execute inside a native backend-managed worktree.
- Merge, PR, reminder, and decision policy remain plugin-owned above both backends.
- Operators should continue sessions by plugin session ID or name. Backend conversation IDs are accepted only for recovery and diagnostics.

## Tool Surface

| Tool | Purpose |
| --- | --- |
| `agent_launch` | Start a background coding session |
| `agent_respond` | Reply, redirect, approve a plan, or escalate permissions |
| `agent_output` | Read buffered session output |
| `agent_sessions` | List active and recent sessions |
| `agent_kill` | Stop or mark a session completed |
| `agent_stats` | Show aggregate usage and cost |
| `agent_merge` | Merge a worktree branch back to base |
| `agent_pr` | Create or update a GitHub PR |
| `agent_worktree_status` | Show authoritative lifecycle state, derived repo evidence, cleanup safety, and retained reasons |
| `agent_worktree_cleanup` | Clean all lifecycle-safe worktrees or dismiss one pending decision without touching live/unsafe worktrees |
| `goal_launch` | Start an explicit verifier or Ralph-style goal loop |
| `goal_status` | Show one goal task or list all goal tasks |
| `goal_stop` | Stop a running goal task |

The chat command surface mirrors the common workflows: `/agent`, `/agent_sessions`, `/agent_output`, `/agent_respond`, `/agent_kill`, `/agent_stats`, `/goal`, `/goal_status`, and `/goal_stop`.

## Docs

| Doc | What It Covers |
| --- | --- |
| [docs/REFERENCE.md](docs/REFERENCE.md) | Install, config, tools, commands, notifications, routing, worktrees, troubleshooting |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Session manager, harness model, notification pipeline, persistence, worktree internals |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Local setup, repo layout, build/test flow, extension points |
| [docs/ACP-COMPARISON.md](docs/ACP-COMPARISON.md) | Current comparison with OpenClaw core ACP |
| [skills/code-agent-orchestration/SKILL.md](skills/code-agent-orchestration/SKILL.md) | Operational skill for orchestrating sessions from an agent |
| [CHANGELOG.md](CHANGELOG.md) | Release history |

## License

MIT. See [LICENSE](LICENSE).
