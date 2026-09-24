# OpenClaw Coding Options and Code Agent

How `openclaw-code-agent` (OCA) relates to the coding surfaces OpenClaw `2026.9.6` ships or installs:

- **ACP / `acpx`**: the ACP runtime backend (`openclaw plugins install @openclaw/acpx`) plus the `openclaw acp` bridge.
- **Codex plugin** (`@openclaw/codex`): the native Codex App Server harness for OpenClaw agent turns, with `/codex` commands.
- **`claude-cli` backend**: the Anthropic plugin's CLI backend that runs Claude Code as a warm subprocess for ordinary turns.
- **Managed worktrees**: core's Gateway-owned git worktrees, surfaced in the Control UI.
- **OCA**: this plugin, which runs Claude Code, Codex, and OpenCode as managed background coding sessions from chat.

They share substrates (Codex App Server, Claude Code, git worktrees) but solve different problems. None of the core options replace OCA's plan review, worktree finish line, or chat follow-through; OCA does not replace ACP interoperability or native Codex turns.

## When To Use Which

| You want | Use |
| --- | --- |
| An ACP client or editor talking to OpenClaw, or one of the ~20 ACP harness aliases (Gemini CLI, Cursor, Copilot, Droid, Kimi, Qwen, ...) | ACP / `acpx` |
| OpenClaw agent turns themselves to run on Codex (model catalog from `model/list`, `/codex` thread control, supervision of native Codex sessions) | Codex plugin |
| OpenClaw agent turns to run on the local Claude Code CLI | `claude-cli` backend |
| An isolated checkout for a Control UI session or `sessions_spawn({ visible: true, worktree: true })` | Managed worktrees |
| A coding job launched from Telegram or Discord that plans first, waits for Approve / Revise / Reject, works in its own worktree, and finishes with a merge or PR decision in the same thread | OCA |

## Side By Side

| | ACP / `acpx` | Codex plugin | `claude-cli` | OCA |
| --- | --- | --- | --- | --- |
| Harnesses | ~20 ACP aliases, including `claude`, `codex`, `opencode` | Codex | Claude Code | Claude Code, Codex, OpenCode |
| Plan review before coding | No (`/acp set-mode plan` has no review UX) | No; turns are forced to Codex `default` collaboration mode | No; Claude Code runs in its default permission mode | Yes: native plan gates, Approve / Revise / Reject buttons, plain-text fallback |
| Approvals | Blanket `permissionMode` (`approve-all` / `approve-reads` / `deny-all`) plus `/acp permissions` | YOLO by default (`approvalPolicy: "never"`); `guardian` mode uses Codex auto-review | Per-call Allow once / Allow always / Deny relay for native tools | Plan approval gate for every harness; Codex adds `harnesses.codex.permissionProfile` / `approvalPolicy` / `approvalsReviewer`, with Codex approval requests shown as chat buttons |
| Fork a session | No | Native snapshot fork for supervised Codex sessions | No | Yes (`fork_session`) |
| Worktrees | No (ACP spawns cannot use managed worktrees) | Runs inside a core managed worktree when placed there | No | Plugin-managed `agent/*` worktrees per session |
| Merge / PR finish line | No | No | No | Yes: `ask`, `delegate`, `auto-merge`, `auto-pr`, repo policy, `agent_merge` / `agent_pr`, buttons |
| Cost | None reported (native-agent path records tokens with cost `0`) | Core provider accounting | Core provider accounting | Per-session USD in completion notices and `agent_stats` |
| Background completion to chat | Task with `done_only` notify | Core chat runtime | Turn-scoped only | Plugin wake pipeline back to the origin thread, including Telegram topics |
| Resume after restart | Persistent sessions and `resumeSessionId` | Codex thread resume | `--session-id` resume | Persisted session catalog; `agent_respond` resumes Claude Code, Codex, and OpenCode sessions |
| Goal loops | No | `/codex goal` inspects Codex goals; auto-continuation disabled | Core `/goal` needs the built-in runtime | `agent_goal_*` verifier or completion-promise loops across harnesses |

## Managed Worktrees and OCA Worktrees

Core managed worktrees live under the Gateway state directory on `openclaw/<name>` branches, are created from the Control UI or `sessions_spawn`, and have snapshot, restore, and idle cleanup but no merge-back, PR, or chat buttons. The plugin API only lets plugins create `ownerKind: "workboard"` worktrees, so OCA keeps its own:

- OCA worktrees live under `<repo>/.worktrees/` (or `worktreeDir` / `OPENCLAW_WORKTREE_DIR`) on `agent/*` branches, so they never collide with core's `openclaw/*` branches.
- OCA honors the same repository conventions as core: `.worktreeinclude` gitignored files are copied into new worktrees, and an executable `.openclaw/worktree-setup.sh` runs afterwards (120 s timeout). See [REFERENCE.md](REFERENCE.md#worktree-provisioning).
- Do not point core `worktreeRoot` and OCA's `worktreeDir` at the same directory.

## What OCA Uniquely Provides

- A plan gate that works the same for Claude Code (native `ExitPlanMode`), Codex, and OpenCode (built-in `plan` agent), answered from chat buttons or plain text.
- Worktree strategies with repo integration policy (`pr-required`, `pr-allowed`, `never-pr`, `manual`) and a merge or PR decision delivered to the originating chat, topic, or orchestrator.
- One session catalog across harnesses: resume, fork, interrupt, restart recovery, output, and cost.
- Verifier-driven goal loops that run on any configured harness.

## What OCA Does Not Do

- It is not an ACP server or runtime backend and does not register providers or model runtimes.
- It does not own `/codex`, `/acp`, or Control UI session placement.
- It does not require the Codex or `acpx` plugins; it talks to `codex app-server`, the Claude Agent SDK, and `opencode serve` directly.

## Sources

Checked against the OpenClaw source and docs for `2026.9.6`: `docs/tools/acp-agents*`, `docs/cli/acp.md`, `extensions/acpx/`, `docs/plugins/codex-harness*`, `extensions/codex/src/app-server/turn-params.ts`, `docs/gateway/cli-backends.md`, `docs/concepts/managed-worktrees.md`, `src/agents/worktrees/`, and `src/plugins/runtime/types.ts`.
