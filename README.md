# OpenClaw Code Agent

[![npm version](https://img.shields.io/npm/v/openclaw-code-agent.svg)](https://www.npmjs.com/package/openclaw-code-agent)
[![npm downloads](https://img.shields.io/npm/dm/openclaw-code-agent.svg)](https://www.npmjs.com/package/openclaw-code-agent)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

`openclaw-code-agent` is the OpenClaw plugin for running Claude Code and Codex as managed background coding sessions from chat. Launch work from Telegram, Discord, or any OpenClaw-supported channel, review the plan before execution, keep the job isolated in its own git worktree, and merge or open a PR without leaving the thread.

- **Plan -> Review -> Execute**. `plan` is the default launch mode, with `ask`, `delegate`, and `approve` deciding how much plan approval autonomy the orchestrator gets.
- **Worktree isolation by default**. New sessions default to `ask`, which creates a clean worktree and `agent/*` branch instead of contaminating your main checkout.
- **State-driven decision UX**. `ask` sends explicit action buttons for **Merge locally**, **Create PR**, **Decide later**, and **Dismiss**. The same action-token model now backs both Telegram and Discord interactive callbacks.
- **Full session lifecycle**. Suspend, resume, fork, interrupt, and recover sessions across restarts with persisted metadata and output.
- **Real operator visibility**. `agent_sessions`, `agent_output`, and `agent_stats` show status, buffered output, duration, and USD cost.
- **Two harnesses, one control plane**. Claude Code and Codex share the same tools, routing, notification pipeline, and worktree model.

Need the version-pinned ACP breakdown? See [docs/ACP-COMPARISON.md](docs/ACP-COMPARISON.md).

## From Prompt To Merged Branch

1. Launch a coding session from chat with `/agent ...` or `agent_launch(...)`.
2. Review the plan in the same thread before anything touches the repo.
3. Let the agent finish in an isolated worktree, then merge or publish the result from chat.

### Plan First

The differentiator is the plan-review loop. Claude Code exposes true plan mode. Codex uses a plan-first turn while the plugin keeps the same external workflow: review the plan, revise if needed, then approve with `agent_respond(..., approve=true)`.

<img src="assets/ask-readme.gif" alt="Plan review in ask mode with inline approval controls">

*`ask` mode keeps the human in the loop: the plan lands back in the originating thread, and execution only starts after approval.*

### Finish Cleanly

When the task is done, the plugin can leave the branch for review, merge it automatically, or help create a PR. In `ask`, the user gets the same explicit decision buttons in the originating thread. In `delegate`, the orchestrator receives the diff context, may merge if safe, and always escalates PR decisions to the user. Planning artifacts belong in `/tmp/` — the agent will not commit analysis notes to the branch.

<img src="assets/delegate-readme.gif" alt="Delegated worktree flow with autonomous follow-through">

*The main checkout stays clean. The branch lifecycle happens in the worktree, and the chat thread stays current on what was shipped.*

## Supported Harnesses

| Harness | Status | Notes |
| --- | --- | --- |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Supported | Native harness via `@anthropic-ai/claude-agent-sdk` |
| [Codex](https://github.com/openai/codex) | Supported | Native harness via `@openai/codex-sdk` thread streaming |

Launches and notifications work from Telegram, Discord, or any OpenClaw-supported channel. Telegram and Discord now share the same action-token callback flow for plan approvals, question options, resume/restart, and worktree decisions.

## Quick Start

Install and enable the plugin:

```bash
openclaw plugins install openclaw-code-agent
openclaw plugins enable openclaw-code-agent
openclaw gateway restart
```

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
          "defaultWorktreeStrategy": "ask",
          "harnesses": {
            "claude-code": {
              "defaultModel": "sonnet",
              "allowedModels": ["sonnet", "opus"]
            },
            "codex": {
              "defaultModel": "gpt-5.4",
              "allowedModels": ["gpt-5.4"],
              "reasoningEffort": "medium",
              "approvalPolicy": "on-request"
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

Launch a first session:

```bash
/agent --name fix-auth Fix the auth middleware bug
/agent_sessions
/agent_respond fix-auth Add unit tests too
/agent_resume --fork fix-auth Try a different approach
```

For multi-workspace or multi-bot setups, configure `agentChannels`. The full routing rules, config matrix, and notification behavior live in [docs/REFERENCE.md](docs/REFERENCE.md).

### Upgrade Note For 3.5.0

`3.5.0` is a maintenance release focused on reliability, explicit session state, and release-tooling hardening.

- Upgrading archives old or invalid persisted session stores to a timestamped `.legacy-*.json` backup and starts with a fresh index.
- Contributors and release automation should use `pnpm verify` as the canonical validation gate.

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
| `agent_worktree_status` | Show branch, PR, and pending-decision state |
| `agent_worktree_cleanup` | Clean up merged agent branches or dismiss a pending worktree decision |

The chat command surface mirrors the common workflows: `/agent`, `/agent_sessions`, `/agent_output`, `/agent_respond`, `/agent_kill`, `/agent_resume`, and `/agent_stats`.

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
