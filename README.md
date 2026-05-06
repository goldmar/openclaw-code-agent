# OpenClaw Code Agent

[![npm version](https://img.shields.io/npm/v/openclaw-code-agent.svg)](https://www.npmjs.com/package/openclaw-code-agent)
[![npm downloads](https://img.shields.io/npm/dm/openclaw-code-agent.svg)](https://www.npmjs.com/package/openclaw-code-agent)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

`openclaw-code-agent` runs Claude Code and Codex as managed background coding sessions from OpenClaw chat. It adds plan approval, session lifecycle, wake routing, worktree isolation, merge/PR follow-through, and explicit goal loops on top of the agent backends.

Use it when you want to start coding work from Telegram, Discord, or another OpenClaw-supported channel and keep the job observable after the first message.

## Highlights

- **Plan -> Review -> Execute**. `plan` is the default launch mode, and plan approval defaults to `delegate` so the orchestrator reviews the full plan before approving or escalating to the user.
- **Delegated worktree isolation**. New sessions default to `delegate`; opt into `ask`, `off`, `manual`, `auto-merge`, or `auto-pr` when you want a different branch follow-through policy.
- **State-driven decision UX**. `ask` sends explicit action buttons for **Merge**, **Open PR**, **Later**, and **Discard**. The same action-token model backs Telegram and Discord interactive callbacks.
- **Lifecycle-first cleanup**. Worktrees are temporary task sandboxes. The plugin distinguishes `merged` from `released` so different-SHA branches whose content already landed on the base branch can still be cleaned safely.
- **Full session lifecycle**. Suspend, resume, fork, interrupt, and recover sessions across restarts with persisted metadata and output.
- **Explicit goal-task loops**. Opt into verifier-driven repair loops or Ralph-style completion loops when you need iterative autonomous execution toward a specific goal.
- **Real operator visibility**. `agent_sessions`, `agent_output`, and `agent_stats` show status, buffered output, duration, and USD cost.
- **Two harnesses, one control plane**. Claude Code and Codex share the same tools, routing, notification pipeline, and worktree strategy model while each backend uses its own native execution substrate.
- **One continuation path**. Follow-ups, approvals, revisions, interrupts, and redirects all continue the existing session instead of launching a duplicate.

This plugin is separate from OpenClaw's bundled `acpx` runtime plugin and bundled core `codex` plugin. Those own adjacent OpenClaw runtime/provider surfaces; `openclaw-code-agent` owns chat orchestration and repository follow-through for its own Claude Code and Codex harnesses. See [docs/ACP-COMPARISON.md](docs/ACP-COMPARISON.md) for the boundary details.

## From Prompt To Shipped Branch

1. Ask OpenClaw to launch a coding session from chat.
2. Review the plan in the same thread before implementation starts.
3. Let the agent finish in an isolated worktree.
4. Merge into the base branch, open a PR, defer the decision, or discard the sandbox from the same control plane.

### Plan First

The core loop is plan review. Claude Code and Codex feed the same approval UX: the plugin receives a structured plan artifact, keeps execution blocked until approval, and continues the same session after the plan is approved. If the user asks for revisions, the revised plan becomes the latest actionable version for that same session.

### Finish Cleanly

When a task completes, the plugin can leave the branch for review, merge it automatically, open or update a PR, or wake the orchestrator with diff context. In `ask`, the user gets explicit decision buttons in the originating thread. In `delegate`, the orchestrator reviews the worktree result and escalates user-facing decisions such as PR creation.

![Delegated worktree flow](https://raw.githubusercontent.com/goldmar/openclaw-code-agent/main/assets/delegate-readme.gif)

*`delegate` keeps the main checkout clean while the branch lifecycle happens in the worktree. The chat thread stays current on what was attempted, what changed, and what follow-through is needed.*

![Ask-mode worktree decisions](https://raw.githubusercontent.com/goldmar/openclaw-code-agent/main/assets/ask-readme.gif)

*`ask` keeps the human in the loop for branch follow-through. Current buttons adapt to state: new branches can show **Merge**, **Open PR**, **Later**, and **Discard**; branches with an existing PR can show **View PR** and **Sync PR** instead of **Open PR**. Older recordings may show prior wording.*

### Worktree Lifecycle

Worktree-backed sessions move through product-facing lifecycle states:

- `active`: sandbox still in use
- `pending decision`: waiting for merge, PR, later, or discard follow-through
- `pr_open`: PR exists and the sandbox is being preserved
- `merged`: branch landed by normal git ancestry
- `released`: content is already on the base branch after rebase, squash, or cherry-pick
- `dismissed`: user intentionally discarded the sandbox
- `no_change`: session finished without a committed delta

Use `agent_worktree_status` for current state and `agent_worktree_cleanup(mode="preview_safe")` before removing resolved sandboxes.

## Quick Start

Install and enable the plugin:

```bash
openclaw plugins install openclaw-code-agent
openclaw plugins enable openclaw-code-agent
openclaw gateway restart
openclaw plugins inspect openclaw-code-agent --runtime --json
```

If OpenClaw blocks installation with a dangerous-code scanner finding for
`child_process`, that is expected for this trusted plugin because it launches
local coding harnesses and git tooling. Review the rationale in
[docs/SECURITY.md](docs/SECURITY.md), then rerun the trusted package/source with
the unsafe-install override:

```bash
openclaw plugins install openclaw-code-agent --force --pin --dangerously-force-unsafe-install
```

Use that override only for a package/source you already trust. When validating a
specific reviewed release, add its version after the package name.

Add the smallest useful config under `plugins.entries["openclaw-code-agent"]` in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "openclaw-code-agent": {
        "enabled": true,
        "config": {
          "defaultWorkdir": "/home/user/project",
          "defaultHarness": "claude-code"
        }
      }
    }
  }
}
```

For the first run, choose:

- `defaultWorkdir`: a git repository root you expect to use often.
- `defaultHarness`: `claude-code` or `codex`.

The default policy is intentionally review-first:

- `permissionMode: "plan"`
- `planApproval: "delegate"`
- `defaultWorktreeStrategy: "delegate"`

Because worktree isolation defaults to `delegate`, `defaultWorkdir` should normally be a git repo. For non-git directories, set `defaultWorktreeStrategy` to `off` or launch with `worktree_strategy: "off"`.

Chat-launched sessions route updates back to their originating chat thread. For agent-launched tool sessions without an origin route, configure `fallbackChannel` or `agentChannels` in the reference guide.

This release targets the OpenClaw SDK package `openclaw@2026.5.5`, while keeping the plugin peer floor at `>=2026.4.21`.

If you use Codex, make sure the local `codex` command or `OPENCLAW_CODEX_APP_SERVER_COMMAND` override is available and authenticated. When Codex auth is inconsistent, this is the recommended `~/.codex/config.toml` setting:

```toml
forced_login_method = "chatgpt"
```

## First Session

In chat, ask OpenClaw to start work:

```text
Start a coding session named fix-auth to fix the auth middleware bug.
```

When the plan arrives, respond in the same thread:

```text
Approve.
```

Send follow-ups as ordinary chat replies:

```text
Add unit tests too.
Show me the latest output.
Stop this session.
```

## Core Workflows

### Plan Review

By default, Claude Code and Codex produce a plan before implementation. The plan can be approved, revised, or rejected through buttons when available, or with plain-text `Approve`, `Revise`, or `Reject` in the same thread.

Revisions stay attached to the same session, so the newest plan is the actionable one.

### Worktree Follow-Through

New sessions use delegated worktree follow-through unless configured otherwise. That keeps changes in an isolated branch and wakes the orchestrator with diff context. In `ask` mode, user-facing buttons depend on state:

| State | Buttons |
| --- | --- |
| New branch and GitHub CLI available | `Merge`, `Open PR`, `Later`, `Discard` |
| Existing PR | `Merge`, `View PR`, `Sync PR`, `Later`, `Discard` |
| GitHub CLI unavailable | `Merge`, `Later`, `Discard` |

Ask OpenClaw for worktree status before cleaning resolved sandboxes.

### Goal Tasks

Goal tasks are explicit autonomous loops for work that should keep iterating toward a defined finish line. They do not replace ordinary coding sessions.

Ask in normal chat:

```text
Start a verifier goal in /repo: fix the failing auth flow and keep running pnpm test until it passes.
Start a Ralph-style goal for /repo: ship the draft workflow, and consider it complete when the output says DONE.
Show goal status.
Stop the auth goal.
```

OpenClaw agents can use the goal tools directly when they need explicit loop control; humans can usually describe the goal in plain language.

## Tools And Commands

Most users interact in chat. The tool surface is for OpenClaw agents and advanced integrations.

| Agent-facing tool | Purpose |
| --- | --- |
| `agent_launch` | Start a background coding session |
| `agent_respond` | Reply, redirect, approve a plan, or escalate permissions |
| `agent_request_plan_approval` | Escalate a delegated plan review to the user |
| `agent_send_plan_offer` | Send a message with Start Plan / Dismiss buttons for a plan-gated follow-up |
| `agent_output` | Read buffered session output |
| `agent_sessions` | List active and recent sessions |
| `agent_kill` | Stop or mark a session completed |
| `agent_stats` | Show aggregate usage and cost |
| `agent_merge` | Merge a worktree branch back to base |
| `agent_pr` | Create or update a GitHub PR |
| `agent_worktree_status` | Show worktree lifecycle state and cleanup safety |
| `agent_worktree_cleanup` | Clean safe worktrees or dismiss one pending decision |
| `goal_launch` | Start an explicit verifier or Ralph-style goal loop |
| `goal_status` | Show one goal task or list all goal tasks |
| `goal_stop` | Stop a running goal task |

Chat commands mirror the common workflows when you want explicit commands instead of natural-language chat, but most human use should start with plain requests like the examples above. Available commands are `/agent`, `/agent_sessions`, `/agent_output`, `/agent_respond`, `/agent_kill`, `/agent_stats`, `/goal`, `/goal_status`, and `/goal_stop`.

## Docs

| Doc | What It Covers |
| --- | --- |
| [docs/REFERENCE.md](docs/REFERENCE.md) | Full operator reference: install, config, tools, commands, routing, worktrees, troubleshooting |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Internal architecture and lifecycle design |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Local setup, validation, release prep, extension points |
| [docs/SECURITY.md](docs/SECURITY.md) | Accepted subprocess surfaces, verifier shell boundary, scanner findings |
| [docs/ACP-COMPARISON.md](docs/ACP-COMPARISON.md) | Boundary with OpenClaw ACPX and bundled Codex surfaces |
| [skills/code-agent-orchestration/SKILL.md](skills/code-agent-orchestration/SKILL.md) | Operational skill for orchestrating sessions from an agent |
| [CHANGELOG.md](CHANGELOG.md) | Release history |

## License

MIT. See [LICENSE](LICENSE).
