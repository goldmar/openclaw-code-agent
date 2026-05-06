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
- **One continuation primitive**. `agent_respond` is the only way to continue, approve, revise, or redirect an existing session. Forks still go through `agent_launch(..., resume_session_id=..., fork_session=true)`.

This plugin is separate from OpenClaw's bundled `acpx` runtime plugin and bundled core `codex` plugin. Those own adjacent OpenClaw runtime/provider surfaces; `openclaw-code-agent` owns chat orchestration and repository follow-through for its own Claude Code and Codex harnesses. See [docs/ACP-COMPARISON.md](docs/ACP-COMPARISON.md) for the boundary details.

## From Prompt To Shipped Branch

1. Launch a coding session from chat with `/agent ...` or from tools with `agent_launch(...)`.
2. Review the plan in the same thread before implementation starts.
3. Let the agent finish in an isolated worktree.
4. Merge into the base branch, open a PR, defer the decision, or discard the sandbox from the same control plane.

### Plan First

The core loop is plan review. Claude Code and Codex feed the same approval UX: the plugin receives a structured plan artifact, keeps execution blocked until approval, and resumes the same session with `agent_respond(..., approve=true)`. If the user asks for revisions, the revised plan becomes the latest actionable version for that same session.

### Finish Cleanly

When a task completes, the plugin can leave the branch for review, merge it automatically, open or update a PR, or wake the orchestrator with diff context. In `ask`, the user gets explicit decision buttons in the originating thread. In `delegate`, the orchestrator reviews the worktree result and escalates user-facing decisions such as PR creation.

![Delegated worktree flow](https://raw.githubusercontent.com/goldmar/openclaw-code-agent/main/assets/delegate-readme.gif)

*`delegate` keeps the main checkout clean while the branch lifecycle happens in the worktree. The chat thread stays current on what was attempted, what changed, and what follow-through is needed.*

![Ask-mode worktree decisions](https://raw.githubusercontent.com/goldmar/openclaw-code-agent/main/assets/ask-readme.gif)

*`ask` keeps the human in the loop for branch follow-through. The current button labels are **Merge**, **Open PR**, **Later**, and **Discard**; older recordings may show prior wording.*

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

Chat-launched sessions route updates back to their originating chat thread. For tool-launched sessions without an origin route, configure `fallbackChannel` or `agentChannels` in the reference guide.

If you use Codex, make sure the local `codex` command or `OPENCLAW_CODEX_APP_SERVER_COMMAND` override is available and authenticated. When Codex auth is inconsistent, this is the recommended `~/.codex/config.toml` setting:

```toml
forced_login_method = "chatgpt"
```

## First Session

From chat:

```bash
/agent --name fix-auth Fix the auth middleware bug
/agent_sessions
/agent_respond fix-auth Add unit tests too
```

From a tool call:

```text
agent_launch(
  prompt: "Fix the auth middleware bug and add tests",
  name: "fix-auth",
  workdir: "/home/user/project"
)
```

Continue existing work with `agent_respond`. Fork from prior context only when you want a separate session:

```text
agent_launch(
  prompt: "Try a different implementation",
  resume_session_id: "fix-auth",
  fork_session: true
)
```

## Core Workflows

### Plan Review

With the default `permissionMode: "plan"`, Claude Code and Codex produce a plan before implementation. The plan can be approved, revised, or rejected through buttons when available, or with plain-text `Approve`, `Revise`, or `Reject` in the same thread.

`agent_respond(..., approve=true)` approves the latest actionable plan version for that session.

### Worktree Follow-Through

New sessions default to `defaultWorktreeStrategy: "delegate"`, which keeps changes in an isolated branch and wakes the orchestrator with diff context. In `ask` mode, the user gets action buttons:

- `Merge`
- `Open PR`
- `Later`
- `Discard`

Use `agent_worktree_status` to inspect worktree state and `agent_worktree_cleanup(mode="preview_safe")` before cleaning resolved sandboxes.

### Goal Tasks

Goal tasks are explicit autonomous loops. They do not replace ordinary `agent_launch`.

```bash
/goal --workdir /repo --verify "pnpm test" Fix the failing auth flow
/goal --workdir /repo --mode ralph --completion-promise DONE Ship the draft workflow
```

Use `goal_status` to inspect progress and `goal_stop` to stop a loop.

## Tools And Commands

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
| `agent_worktree_status` | Show worktree lifecycle state and cleanup safety |
| `agent_worktree_cleanup` | Clean safe worktrees or dismiss one pending decision |
| `goal_launch` | Start an explicit verifier or Ralph-style goal loop |
| `goal_status` | Show one goal task or list all goal tasks |
| `goal_stop` | Stop a running goal task |

Chat commands mirror the common workflows: `/agent`, `/agent_sessions`, `/agent_output`, `/agent_respond`, `/agent_kill`, `/agent_stats`, `/goal`, `/goal_status`, and `/goal_stop`.

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
