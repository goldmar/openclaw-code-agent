# Changelog

All notable changes to `openclaw-code-agent` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

5.0.0 makes OCA thinner on top of OpenClaw 2026.9.6: it adopts the public plugin-SDK surfaces for delivery, logging, state, and system events; moves the Claude Code, OpenCode, and Codex harnesses onto their native protocols; and removes 4.x compatibility layers. Read **Breaking changes** before upgrading; [REFERENCE.md](docs/REFERENCE.md#upgrading-from-4x) has the migration steps. OpenClaw `2026.9.6` is both the installation target and the minimum supported host.

### Breaking changes

- **Tool surface: 19 tools became 14 (+1 opt-in).** Tool definitions shrink from about 5.2k to about 3.0k tokens per agent turn. Update agent tool allowlists that name OCA tools:

  | 4.x | 5.0 |
  | --- | --- |
  | `agent_goal_launch(goal, …)` | `agent_goal(action="launch", goal, …)` |
  | `agent_goal_status(task?)` (also `name` / `id`) | `agent_goal(action="status", task?)`; the `name` and `id` aliases are gone |
  | `agent_goal_edit(task, goal)` | `agent_goal(action="edit", task, goal)` |
  | `agent_goal_stop(task)` | `agent_goal(action="stop", task)` |
  | `agent_request_plan_approval(session, summary)` | `agent_escalate(session, kind="plan", summary)` |
  | `agent_request_worktree_decision(session, summary)` | `agent_escalate(session, kind="worktree", summary)` |
  | `agent_send_plan_offer` (always registered) | registered only with the new `planOfferTool: true` config |
  | `agent_worktree_cleanup(dry_run=true)` | `agent_worktree_cleanup(mode="preview_safe")` |
  | `agent_worktree_cleanup(skip_session_check / force)` | removed (they had no effect) |
  | `agent_pr(update_body=true)` | `agent_pr(update_metadata=true)` |
  | `/agent_goal_status [task]` | `/agent_goal status [task]` |
  | `/agent_goal_edit <task> <goal>` | `/agent_goal edit <task> <goal>` |
  | `/agent_goal_stop <task>` | `/agent_goal stop <task>` |

  Enum parameters are now plain JSON Schema string enums (`{"type": "string", "enum": [...]}`) instead of `anyOf` literal lists.
- **Orchestrator contract (wakes).** Wake texts were rewritten to be short: the session is named `[name]`, the origin route appears once as `originRoute: {…}`, and approval-state lines appear only for an anomaly (`implemented_without_required_approval`). Prompts or parsers that matched the 4.x wording (`[DELEGATED PLAN APPROVAL]`, `[DELEGATED WORKTREE DECISION]`, `Completion diagnostics:`, `Session origin route (authoritative …)`, `Requested permission mode:`) must be updated. Context the orchestrator needs only if the user answers in chat (a question or plan prompt that reached the user, a worktree prompt with buttons, a Revise press) is queued for its next turn instead of starting a turn; the "repo policy buttons delivered" wake and the plan-timeout wake for a prompt the user already has are no longer sent.
- **User messages.** `agent_respond` no longer echoes the user's own words back (`↪️ [name] "…"`). Merge and PR outcome lines name the session (`✅ [name] Merged: …`). The worktree prompt starts `🔀 [name] Finished on …` with a one-line Discard warning, and its buttons use one fixed layout (Merge, Open PR or Sync PR, View PR link / Later, Discard). The repository policy question is four short lines; tool syntax appears only in the orchestrator's text when the buttons could not be delivered. The update prompt offers **Update now** / **Remind later** (again in a day) / **Skip this version** (never again for that version); the restart prompt offers **Restart Gateway** / **Not now**. Stale worktree-decision reminders come after 3h, 24h and a week, then stop (4.x reminded every 3 hours indefinitely).
- **`/agent`.** The command reply is now the single launch message (no separate `🚀` notice), and `--workdir`, `--harness` and `--model` can precede the prompt.
- **Session listings.** `agent_sessions` rows show a plain-language state (`waiting for plan approval`, `suspended (a message resumes it)`, …) instead of internal phase, lifecycle and approval-state names, and no longer show `multi-turn`, the backend id, or `Resumable`.
- Goal loops (`agent_goal(action="launch")`, `/agent_goal`): the first iteration now uses the configured `permissionMode` (default `plan`) instead of `bypassPermissions`, so its plan goes through the normal plan approval; the loop never approves its own plan, and later iterations continue within the approved scope. Verifier commands supplied by the orchestrator run only after the user confirms them once (a message listing the exact commands with **Run these checks** / **Cancel** buttons); commands typed in `/agent_goal` or listed in the new `trustedVerifierCommands` config run without it. `max_iterations` is capped at 25, restarts count as iterations, and the task stops after the same failure repeats 3 times.
- Goal verifier commands run with `bash -c` (no login profile) and a minimal allowlisted environment without API keys or tokens, and the worktree setup script gets the same minimal environment. Commands that relied on inherited variables must set them themselves.
- `planApproval: "ask"`: `agent_respond(approve=true)` is refused (with or without `userInitiated`); only the user's Approve button or the user's own reply forwarded as text with `userInitiated=true` approves the plan.
- `.worktreeinclude` and `.openclaw/worktree-setup.sh` are read from the commit the source checkout has checked out, never from the working tree: untracked or modified copies are ignored (commit them to take effect), and the setup script runs from a private temporary copy (find files through `OPENCLAW_WORKTREE_PATH` / `OPENCLAW_SOURCE_TREE_PATH` or the working directory, not `$0`).
- A merge or PR whose branch changes git hooks or worktree setup files (`.husky/`, `.githooks/`, the in-repo `core.hooksPath` directory, `.openclaw/worktree-setup.sh`, `.worktreeinclude`) is no longer automatic: `auto-merge` / `auto-pr` ask the user, and orchestrator calls to `agent_merge` / `agent_pr` are refused, with a prompt that names the files.
- The Codex app server, the Claude Agent SDK, and the OpenCode server no longer inherit secrets unrelated to a coding agent (`GH_TOKEN`, `GITHUB_TOKEN`, npm/ClawHub/1Password/cloud tokens, chat bot tokens, and `OPENCLAW_*TOKEN`/`PASSWORD`/`SECRET`); see REFERENCE "Child process environments". An agent that needs the GitHub CLI uses `gh`'s stored login.
- Claude Code questions no longer expire after 10 minutes (the agent used to continue on its own judgment); like Codex and OpenCode questions they wait until answered or until the session is idle-suspended, and each question is posted once.
- A Codex resume id that is not a Codex thread UUID now fails the launch instead of silently starting a fresh thread.
- Codex sessions require Codex CLI `0.156.1` or newer. The harness reads the version from the App Server's `initialize` `userAgent` and fails the launch, before any thread starts, when it is older or cannot be read; the error names the reported and the required version. 5.0 relies on `turn/steer`, `thread/fork` `beforeTurnId`, `thread/revert`, `model/list`, the account rate-limit methods, and thread permission profiles.
- Minimum OpenClaw host is now `2026.9.6` for installation, the plugin API, the Gateway, and the `openclaw` peer dependency (previously `2026.8.1` for the last three). OCA calls the 2026.9.6 plugin runtime directly: the Task Flow mirror no longer probes for the async managed-flow binding, `requestCancel`, or `get`, and always creates flows with `tryCreateManaged`; `runtime.llm`, `runtime.system`, and `runtime.logging` are no longer presence-checked. The console logger remains only for code that runs before plugin registration.
- In-process API renames for integrations that drive OCA directly: `SessionManager.spawn` is now `SessionManager.launchSession` and `spawnAndAwaitRunning` is `launchAndAwaitRunning`. The branch-name helpers in `src/worktree-ref-validation.ts` (`branchNameValidationError`, `assertBranchName`, `localBranchRef`, `branchOrRemoteTrackingRef`) are asynchronous.
- Session references no longer match a bare `harnessSessionId`. Sessions, persisted rows, worktree targets, and Codex resume owners are matched by OCA session id, name, or backend conversation id. Every loadable row already carries its backend ref (4.x Claude Code rows get one synthesized on load), and a live session's `harnessSessionId` always equals its backend conversation id.
- Codex resume ids must be plain Codex thread UUIDs; the `urn:uuid:` prefix is no longer accepted (Codex never emits it).
- A launch that needs a worktree outside a git repository now fails with a clear error. Previously, without `worktreeDir` or `OPENCLAW_WORKTREE_DIR`, the worktree base directory fell back to the OS temp directory.
- Removed the deprecated flat config keys `defaultModel`, `model`, `reasoningEffort`, and the global `allowedModels`. They are no longer migrated: the config schema keeps `additionalProperties: false`, so OpenClaw refuses to load the plugin while they are set (`invalid config: must not have additional properties: "defaultModel"`). Move them to `harnesses.<name>.defaultModel` / `allowedModels` / `reasoningEffort` before upgrading.
- Session store upgrade: a 4.7.x `code-agent-sessions.json` loads in place. Rows or action tokens that no longer normalize are dropped individually after OCA writes a verbatim `.legacy-<timestamp>.json` backup, instead of one bad row archiving the whole store. Retired `planApprovalContext` values (`soft-plan`, `codex-first-turn-plan`) are dropped instead of remapped to `plan-mode`. Worktree rows without `worktreeLifecycle` get it synthesized on load from `worktreeMerged`, `worktreeDisposition`, and `worktreeState`; retention cleanup no longer re-derives resolution from those legacy fields. Back up `code-agent-sessions.json` and `code-agent-goal-tasks.json` before upgrading: 4.7.x reads the same schema version, so a downgraded build loads the rewritten store without an error but may drop or misread 5.0-only data. To roll back, stop the Gateway, reinstall 4.7.20, and restore the backup ([REFERENCE.md](docs/REFERENCE.md#upgrading-from-4x) has the steps); sessions started under 5.0 are lost to OCA, while their worktrees and branches stay in git.
- Button callbacks are read only from the payload OpenClaw's interactive dispatcher provides (`ctx.callback.payload` on Telegram, `ctx.interaction.payload` on Discord, namespace already stripped). Probing of `callback.data`, `callback_data`, `callbackData`, and `interaction.data`, the label-payload fallback, and the Discord `clearButtons` fallback are gone. OpenClaw has provided the payload this way since `2026.8.1`.
- Worktree-layer `git` / `gh` calls are asynchronous, so `SessionManager.launchSession`, repo-policy resolution, worktree lifecycle resolution, and the `src/worktree*.ts` helpers now return promises. In-process integrations that call them must `await`.
- State paths now follow the Gateway: OCA resolves its state directory with the host's `resolveStateDir`, so `OPENCLAW_STATE_DIR` is honored and `OPENCLAW_HOME` is treated as the home-directory override (state in `$OPENCLAW_HOME/.openclaw`) instead of as the state directory itself. Operators who set `OPENCLAW_HOME` to point OCA at a state directory should set `OPENCLAW_STATE_DIR` (or `OPENCLAW_CODE_AGENT_SESSIONS_PATH` / `OPENCLAW_CODE_AGENT_GOAL_TASKS_PATH`) instead.
- Session output transcripts move from `/tmp/openclaw-agent-<id>.txt` to `<stateDir>/plugin-state/openclaw-code-agent/output/` (private directory and files). Existing `/tmp` transcripts stay readable through their stored paths and are aged out by the normal maintenance cleanup.
- Removed the age-based startup sweep that deleted unmanaged `openclaw-worktree-*` directories (and the `OPENCLAW_WORKTREE_CLEANUP_AGE_HOURS` knob). Managed worktrees are still cleaned by the maintenance schedules and `agent_worktree_cleanup`; review and remove unmanaged directories with `git worktree remove`/`git worktree prune`.
- Direct notifications no longer fall back to `openclaw message send`, and OCA no longer retries a failed direct send: the host durable outbound queue owns retries of an admitted send. A send that times out with an unknown outcome is reported as failed without a system-event resend.
- Claude Code plan review now uses Claude Code's native `ExitPlanMode` request instead of scraping the final turn text. OCA holds the request open until the decision and answers it directly: approval is an `allow` with a session-scoped mode switch (normally `bypassPermissions`), and revision feedback is a `deny` carrying the user's words. Plans no longer appear as a finished turn; the plan-review notification fires while the turn is held. Plan text and `planFilePath` come from the tool input; the `.claude/plans/` write heuristic, `ExitPlanMode`/`set_permission_mode` tool-name signals, and `[SYSTEM: …]` approval/revision prefixes are gone for Claude Code and OpenCode (Codex keeps its prompt framing). An approval that arrives after the session was idle-suspended still resumes it in `bypassPermissions`, now with a plain approval message.
- OCA no longer copies MCP servers from `~/.claude.json` into Claude Code launches. Claude Code loads user, project, and local MCP servers from its own settings sources.
- OpenCode runs on one shared, lazily started `opencode serve` process instead of one server per session, started with `--port 0` and addressed through the URL it prints. Every request carries `?directory=`, completion comes from the `/global/event` stream, and the server shuts down about 30 seconds after the last OpenCode session. `interrupt` now aborts only the in-flight OpenCode turn; closing the session stops it.
- Codex: pre-App-Server Codex SDK session rows are no longer archived or migrated; they are dropped when the session store loads, and the `legacy_non_resumable` resume state is gone. Persisted App Server sessions resume as before.
- Codex: native backend worktree restore is removed (the Codex App Server has no worktree API). `backendRef.worktreePath`/`worktreeId` and the `worktrees` backend capability no longer exist; every harness uses plugin-managed worktrees. Resuming a Codex session whose worktree was already cleaned up now fails closed like other harnesses instead of creating a new worktree. Persisted 4.x rows whose worktree was a native Codex backend worktree load without worktree metadata, so OCA merge/discard/cleanup never touches Codex-owned checkouts.
- Codex: `harnesses.codex.reasoningEffort` no longer defaults to `medium`. Unset means Codex's own configured/model default (Codex was effectively already ignoring OCA's effort because of the payload bug below).
- Codex follows the host `tools.exec.mode` when `harnesses.codex.permissionProfile` / `approvalPolicy` / `approvalsReviewer` are unset. Hosts without `tools.exec.mode` (or with `full`) keep the 4.x full-access, no-prompt behavior. With `tools.exec.mode: "auto"` Codex now runs in the `:workspace` sandbox with `on-request` escalations reviewed by Codex's `auto_review` subagent (network access such as `git push` to a real remote, and git writes to the main checkout's `.git`, become reviewed escalations); `ask` routes those approvals to chat; `deny` / `allowlist` refuse Codex launches. Set `harnesses.codex.permissionProfile: ":danger-full-access"` and `approvalPolicy: "never"` to keep full access on such hosts. OCA's `permissionMode` no longer changes Codex execution: in 4.x `bypassPermissions` always meant `danger-full-access` with no approvals, while in 5.0 a `bypassPermissions` session on an `auto` or `ask` host runs in the `:workspace` sandbox, and on a `deny` / `allowlist` host it is refused.
- Codex: the per-session `codexApprovalPolicy` field is removed from session config, persisted rows, and repo-policy launch tokens; Codex execution settings now come from `harnesses.codex` (see Added).
- In-process API: `SessionManager.resetRepoPolicy(ref)` now returns the removed `RepoPolicyRecord[]` instead of a boolean.
- New `agent_session_action` tool (see Added). Agents whose tool allowlists name OCA tools individually must add it; OpenClaw does not add new plugin tools to an explicit allowlist.
- `agent_kill` rejects parameters other than `session` and `reason` (its schema sets `additionalProperties: false`). Previously unknown fields were ignored and the call still stopped the session.

### Added

- `agent_merge` and `agent_pr` take an optional `summary` (one or two lines for the user). It is shown under the outcome line, and the outcome wake that asks the orchestrator for a follow-up summary is skipped.
- `approval_rationale` is shown to the user in the approval notice (`👍 [name] Plan approved` followed by `Why: <rationale>`), so a delegated approval needs no separate explanation.
- `agent_sessions(status="waiting")` and the new `/agent_status` command list the sessions that wait for a plan decision, an answer, or a merge / PR decision, with the next step.
- After the user presses **Revise**, the orchestrator gets a queued note that the user's next chat message is the requested change.
- A session that finishes with uncommitted changes and no commits gets **Commit changes** (resume with a commit instruction), **View output** and **Discard** buttons.
- **View output** no longer removes the message's other buttons and can be pressed again; **View PR** is a link button.
- `planOfferTool` config key (default `false`) registers `agent_send_plan_offer`.

- `worktreeGitHooks` config (`run` default, or `skip`): repository hooks during OCA's own merge, rebase, squash commit, push, and `git worktree add`; `skip` runs them with `core.hooksPath=/dev/null`.
- `trustedVerifierCommands` config: goal verifier commands the operator pre-approves.
- `agent_goal` `max_cost_usd` / `/agent_goal --max-cost-usd`: stop a goal loop before the next iteration once its sessions cost that much.

- `autoUpdate` plugin config key (default `true`). When on, the daily update check and its **Update now** / **Restart Gateway** buttons work as before: OCA reinstalls itself only after an explicit **Update now** press and restarts the Gateway only after a separate **Restart Gateway** press. `false` disables update checks, installs, and restarts.
- `pnpm check-clawhub-scan` (part of `pnpm verify`) runs ClawHub's static moderation scan over the exact packed file list and fails on any finding. It uses the vendored engine in `scripts/vendor/clawhub-moderation-engine.mjs` (MIT, regenerate with `pnpm sync:clawhub-scan`). The release workflow also scans the exact tarball it publishes. Two extra guards: `fetch(` may appear only in the npm release-client chunk, and no packed file may combine `process.env` with a network call.
- `docs/SECURITY.md` ships in the package, and the README has a Security section covering subprocesses, self-update, network use, and data locations.
- The live Codex smokes (`pnpm smoke:codex-live`, `pnpm smoke:codex-release`) first run the `sync:codex-protocol` drift check (`scripts/sync-codex-protocol.mjs --check`) against the installed Codex CLI.
- New OCA worktrees honor OpenClaw's managed-worktree conventions: gitignored files listed in `.worktreeinclude` are copied in, and an executable `.openclaw/worktree-setup.sh` runs in the new worktree (120 s timeout, process-group kill). A failure fails the launch and removes the new worktree and branch. OCA keeps its `agent/*` branch prefix.
- Upgrade test fixture for a representative 4.7.20 session store.
- Full-stack tests through the real plugin entry on a fake host (`tests/fullstack-*.test.ts`): the question, plan-approval, and worktree flows over the real WakeDispatcher and delivery transports on Telegram topics and Discord threads, fault injection (a restart from every store snapshot, failing saves, a failing or hung host model, backends dying mid-turn, a Gateway stop during a Merge), a fast-check two-writer store model, and end-to-end coverage of the goal loop, the auto-merge conflict resolver, the snooze reminder, and the session buttons.
- `pnpm check-static-guardrails` rejects Telegram chat ids other than the documented fakes and token-shaped strings outside an explicit fixture allowlist in `src/`, `tests/`, `docs/`, `scripts/`, `skills/`, `.github/`, and the top-level docs.
- Claude Code: pass OCA's review workflow as `planModeInstructions`; set `projectConfigRoot` to the original checkout for worktree sessions; report structured failures from `is_error`, assistant `error` codes, `startup_failure_reason`, and `terminal_reason` (aborted turns are interrupted turns, not failures); take cost from per-model `modelUsage`; read the applied model and effort from `system/init` or `supportedModels()`; show per-model cost, context fill (`getContextUsage()`), and live background tasks in `agent_output`; consume session-state and `permission_denied` events.
- Completed Claude Code sessions are resumable like Codex and OpenCode sessions. OCA validates the transcript with the SDK's `getSessionInfo()` before resuming.
- OpenCode: multi-select question answers, reasoning effort as the prompt `variant`, and turn duration, per-model tokens, and cost from OpenCode's message records.
- Codex approvals: `harnesses.codex.permissionProfile` (`:danger-full-access`, `:workspace`, `:read-only`), `harnesses.codex.approvalPolicy` (`never`, `on-request`, `untrusted`), and `harnesses.codex.approvalsReviewer` (`user`, `auto_review`). When unset they follow the host `tools.exec.mode` (see Breaking changes). Explicit values always win, unlike the bundled Codex plugin, where `tools.exec.mode: "auto"` overrides them. The mode is read from the live config at each Codex launch. Command, file-change, and permission requests are shown as approval buttons with typed decisions (including "Always allow `<prefix>`"); unrecognized text replies decline and are steered into the turn as feedback.
- Codex steering: `agent_respond` during a running Codex turn uses `turn/steer` with `expectedTurnId` instead of queueing; `interrupt: true` still interrupts.
- Codex rewind: `agent_launch(resume_session_id, rewind_turns=N)` forks before the last N turns (`fork_session: true`, via `thread/fork` `beforeTurnId`) or reverts them in place (`thread/revert`).
- New `agent_session_action` tool: `compact` (`thread/compact/start`) and inline `review` (`review/start`, defaulting to the worktree branch diff) for running Codex sessions.
- `agent_stats` shows the latest Codex account usage-limit windows per account (account ids are never shown) (`account/rateLimits/read` + `account/rateLimits/updated`); usage-limit turn failures include the reset time.
- Codex model catalog from `model/list` drives effort validation and the `reasoning:` status suffix instead of hand-maintained model regexes.
- Vendored Codex App Server protocol types generated by `codex app-server generate-ts --experimental` (`src/harness/codex-app-server-protocol/`, regenerate with `pnpm sync:codex-protocol`).
- Codex (API-key accounts) and OpenCode report the running session cost mid-turn, so `agent_output` and `agent_sessions` show the spend so far while a turn is open, for example while it waits on a question. OpenCode prices a step only when it finishes, so a step blocked on a question is counted once it resumes.
- Development: `pnpm typecheck` also type-checks `tests/` (`tsconfig.tests.json`). The Codex and OpenCode test fakes are typed with the vendored protocol types and validated at run time against the vendored Codex App Server JSON Schema (`tests/protocol/codex-app-server.schema.json`, refreshed and drift-checked by `pnpm sync:codex-protocol [--check]`) and OpenCode OpenAPI document (`tests/protocol/opencode-openapi.json`, from `opencode serve` `/doc`, `pnpm sync:opencode-openapi [--check]`).
- Development: `tests/fake-host.ts`, a fake OpenClaw host typed against the plugin SDK (`runtime.llm`, system events, managed Task Flows, `sendDurableMessageBatch`, logging, state paths, and tool/command/service/interactive registration), and `tests/fake-github.ts` (real git repositories behind a `git@github.com:` remote plus a scriptable `gh`) for execute-level `agent_pr` and auto-PR tests.
- Development: `pnpm coverage` reports line, branch, and function coverage of `src/` for the suite (V8 coverage rendered by c8; reporting only, not a gate).
- Development: model-based and property tests (fast-check, a dev dependency) for the session control reducer, the button token lifecycle and worktree decisions, session routes against the host's session-key builders, answer parsing, store and config normalization, and callback payloads. CI runs them with a fixed seed and small run budgets; `OCA_PROPERTY_RUNS` and `OCA_PROPERTY_SEED` enable a deeper search (see `docs/DEVELOPMENT.md` "Property And Model-Based Tests").

### Changed

- `pnpm build` deletes `dist/` before bundling, and a `prepack` script runs the build, so `npm pack` and registry publishing cannot ship stale chunks.
- Fixed-command subprocesses name their executable literally (`execFile("git", [...])`, `execFile("gh", [...])`, `execFile("openclaw", [...])`, no shell). The last synchronous `git check-ref-format` calls now go through the async `runGit`, so `src/` has no `execFileSync` left.
- Claude Code failures include the structured error code in the failure text (for example `Invalid API key (error code: authentication_failed)`).
- A question answered after a Gateway restart resumes the session with a plain-language note instead of a `[SYSTEM: …]` prefix.
- The `planApproval: "approve"` wake and skill guidance require the orchestrator to read and verify the full plan first, and to send destructive, credential-touching, or out-of-scope plans to the user, instead of saying "Approve it now".
- Removed the manifest and uiHints claim that the Codex execution policy is fixed at `never`; they point to `harnesses.codex.permissionProfile` / `approvalPolicy` / `approvalsReviewer`.
- Worktree, merge, PR, repo-policy, and lifecycle-resolver `git` / `gh` calls run through an async `execFile` runner (`src/git-exec.ts`) instead of about 40 blocking `execFileSync` calls, with the same timeouts, argument arrays, and error text. Mutating git sequences are serialized per repository, launches are serialized, and maintenance applies only its latest schedule.
- Tool parameter schemas are built with TypeBox (`typebox` 1.3.34, bundled), the schema library the plugin SDK types tool parameters with, instead of a local `Type.*` clone. Only the builders the tools use are bundled.
- The esbuild chunk names include a content hash.
- Release-metadata validation and the plugin-entry tests derive the OpenClaw target and compatibility floor from `package.json`, so a compatibility bump no longer needs hand-edited test literals.
- Docs: REFERENCE's per-release upgrade notes are condensed into **Compatibility And Upgrades**; ACP-COMPARISON is refreshed for OpenClaw 2026.9.6 (acpx, the Codex plugin, the `claude-cli` backend, and managed worktrees); REFERENCE no longer claims SDK `:topic:` parsing or a `runtime.taskFlow` fallback.
- Docs refresh for 5.0: the README opens with a **What's New In 5.0** summary and an upgrade note, lists every registered tool, and documents questions, steering, rewind, and review. REFERENCE, ARCHITECTURE, DEVELOPMENT, SECURITY, CONTRIBUTING, and the orchestration skill are corrected against the code (tool parameters and chat-command usage, allowlist matching, resume behavior, routing order, release authentication, subprocess and environment inventory). The manifest descriptions for `idleTimeoutMinutes` (suspends, not kills), `maxPersistedSessions`, and `allowedModels` are corrected, the missing advanced uiHints are added, and the package description no longer promises unnamed extra harnesses.
- Direct notifications use the host durable outbound queue (`sendDurableMessageBatch` from `openclaw/plugin-sdk/channel-outbound`) with a channel-agnostic button `presentation`; core renders Telegram inline keyboards and Discord components, replacing OCA's adapter loading and Telegram button repair.
- Wake fallbacks and system notices use the in-process `api.runtime.system.enqueueSystemEvent` instead of the `openclaw system event --mode now` subprocess, and target the origin session when it is known. Wake fallbacks also call `requestHeartbeat` (immediate `notifications-event` wake). A text-only notice whose direct send failed skips the heartbeat when the same dispatch sends an OCA wake, whose `chat.send` turn picks the notice up; a notice with no following wake still requests one. OpenClaw 2026.9.6 offers no lighter wake: every host heartbeat for a generic system event runs the agent's configured heartbeat prompt and routine.
- Honor `openclaw tasks flow cancel` for mirrored sessions: a host cancel intent stops the coding session. Flow creation uses `tryCreateManaged`.
- Plugin diagnostics, including the Codex harness and App Server RPC diagnostics, are written to the Gateway log through `api.runtime.logging.getChildLogger`; per-dispatch delivery progress is logged at `debug`. No `src/` code writes to `console.*` directly any more.
- The session index, goal task store, and auto-update state are written through the host `json-store` `saveJsonFile` helper: a private (`0600`) temp file in the same directory is fsynced and renamed over the target, and the directory is fsynced on a best-effort basis (on Windows, where rename cannot replace a file, the target is removed first).
- `:thread:` session-key suffixes are parsed with the public `openclaw/plugin-sdk/routing` helper; Telegram `:topic:` parsing stays local.
- `api.runtime` is typed with the published plugin SDK `PluginRuntime`.
- The build externalizes the public SDK subpaths `channel-outbound`, `json-store`, `routing`, and `state-paths` in addition to `plugin-entry`. All four are public SDK subpaths on the OpenClaw `2026.9.6` floor.
- Update `@anthropic-ai/claude-agent-sdk` to 0.3.282 (0.3.281 is the first with Claude Code's `claude-opus-5-5`), and use its public `startup()`/`WarmQuery` and `Query` types.
- Provider-qualified Claude Code models (`anthropic/claude-…`) are now sent as the bare Claude Code id instead of being rejected (`anthropic/claude-opus-5-5` → `claude-opus-5-5`). Stored `anthropic/claude-opus-5-5` defaults no longer need to be changed.
- A user stop (`agent_kill`) now records a Task Flow cancel intent, so the mirrored flow ends as `cancelled` instead of `failed`.
- OpenCode plan mode uses OpenCode's built-in `plan` agent (plus a `bash`/outside-project deny overlay) and switches to the `build` agent after approval, replacing OCA's custom edit/bash/task/todowrite deny list.
- Auto-update state moves to `<stateDir>/plugin-state/openclaw-code-agent/auto-update.json`; the previous `openclaw-code-agent-auto-update.json` is read once as a migration source.
- The PR bundle-size check limit is 700 KB (was 600 KB). The complete `dist/` bundle is almost entirely OCA's own minified code (dependencies are about 10 KB), and 5.0.0 reached the old limit.
- Dependency updates: `@anthropic-ai/sdk` 0.128.0, `@modelcontextprotocol/sdk` 1.30.1, `hono` 4.13.9, `zod` 4.6.5, and, for development, `esbuild` 0.28.2 and `tsx` 4.23.15. Pinned runtime dependencies no longer repeat their versions across files: `package.json` `dependencies` holds the exact pins, `scripts/lib/runtime-dependency-pins.mjs` holds the independent security floors they must not drop below, and the shrinkwrap check, the packed-consumer check, and the matching `pnpm-workspace.yaml` overrides (now checked to equal `package.json`) read from there.
- Dependabot waits 3 days before proposing a release (a `cooldown` for every ecosystem, reversing the 4.7.10 removal), and its auto-merge no longer covers the build toolchain (`esbuild`, `typescript`, `tsx`, and the bundled `typebox`), which now always gets a manual review and its own PRs outside the grouped development updates.
- Release workflow: npm and ClawHub publish from separate jobs. The npm job holds only the OIDC token (`id-token: write`, no checkout, nothing installed), and the ClawHub job reads `CLAWHUB_TOKEN` from the protected `release` environment without OIDC or repository write access. The release tag is created in its own approved job before either publish. The ClawHub CLI (inspector, dry run, and publish, all 0.23.3) is installed with `npm ci` from a committed lockfile in `.github/release-tools/`. The `version` input must be a strict semantic version, workflow inputs reach shell steps only through environment variables, and the release jobs use no dependency cache.
- CI: the bundle-size and frozen-lockfile checks reuse the Node 24 Verify leg's install and build instead of repeating them in a separate workflow (the required check names **Bundle Size Check** and **Lockfile Integrity Check** are kept), the packed npm consumer check runs in that leg, and only superseded pull request runs are cancelled, never runs on `main`.

### Removed

- The dead `.npmignore`: `package.json` `files` decides the package contents, and the packed file list is unchanged.
- Dead code: the unreferenced `summarizeToolInput` helper (`src/notifications.ts`) and the local TypeBox clone (`src/tool-schema.ts`).
- The unused Codex auth-workspace helper (`src/harness/codex-auth.ts` and `resolveCodexAuth*` path helpers).
- 4.x compatibility wrappers: `SessionManager.resolveHarnessSessionId`, `SessionStore.resolveHarnessSessionId`, and the `SessionManager.persisted` / `idIndex` / `nameIndex` getters. Use `resolveBackendConversationId`.
- `harnessSessionId` fallback matching in session references, state sync, worktree tool targets, persisted mutation refs, notification dedupe lookups, and Codex resume-owner checks (see Breaking changes).
- The unused `src/openclaw-paths.ts` (which still used the pre-5.0 `OPENCLAW_HOME` meaning) and unused exports: button-diagnostics payload summaries, `getDefaultCodexModelInfo`, unused `api.ts` handler-registration types and SDK re-exports, and the exported Codex wire-type guards.

### Fixed

- An early startup failure on resume (for example a usage-limit or auth error) auto-cleaned the resumed session's worktree and ran `git branch -D` on its branch, deleting unmerged commits. Only a worktree the launch created is cleaned, and a branch with commits of its own is never deleted.
- When runtime GC re-persisted a terminal session after 24 hours, the row lost its PR, merge, disposition, repo-policy and completion-wake fields, so the worktree buttons fell back to Merge + PR. Fields the runtime session does not track are now kept.
- `agent_pr` could rewind a local PR branch that had unpushed commits (`git branch -f`). It now only fast-forwards (compare-and-swap) and refuses otherwise.
- A merge switched the user's main checkout to the base branch and left it there, and popped the auto-stash onto the wrong branch. A merge now never switches a checkout: base moves where it lives (merged in place when checked out, otherwise updated directly), the rebase runs in the session worktree or a temporary worktree, uncommitted changes in the session worktree are reported as such instead of as a rebase conflict, and rebasing an already pushed branch adds a warning.
- Output-file cleanup deleted other processes' live output: it ignored rows carried for another writer and swept the shared legacy temp directory. It now honors every row, keeps unreferenced files younger than an hour, and never sweeps the temp directory.
- An older build archived and overwrote a newer-schema session index, and backed up an unmergeable index on every save. A newer index is now left untouched (the older build keeps its changes in memory), and a backup is written once per distinct content.
- The session index three-way merge compared rows as JSON strings in different key orders, so a synced row always looked locally changed: another writer's later updates were discarded and its evictions undone. Rows are compared in one canonical form (normalized, sorted keys).
- Session index lock races: breaking a stale lock could delete a lock another writer had just taken, and a deferred save force-broke a live lock after 5 s although locks count as stale only after 10 s. Stale locks are broken atomically (rename, verify, restore), locks are released only by their holder, and a deferred save never breaks a live lock.
- Raw agent output went unfenced into orchestrator wakes, and question wakes told the orchestrator to auto-respond to permission requests. Agent output (previews, plan text, questions, failure summaries, commit messages) is now wrapped in a random per-message delimiter labeled as untrusted data, and the auto-respond instruction is gone.
- Goal verifiers: output over 1 MB failed a passing check, and processes a timed-out check started were orphaned. Only the output tail is kept, and the whole process group is killed on timeout (the timeout is bounded to 1 s..30 min).
- OpenCode sent the system prompt (worktree preamble and launch instructions) only on the first turn, but OpenCode applies only the latest message's `system`; it is now sent with every prompt.
- Sessions could be idle-killed in the middle of a turn: Codex reports no progress during a long, silent command, and Claude Code's progress heartbeats were dropped. A working turn is no longer idle, and Claude progress messages count as activity.
- OpenCode turns failed after a hard 15-minute limit that also counted time waiting for the user, and the timed-out turn kept running (and spending) on the server. The limit now measures inactivity, pauses while a question waits, and aborts the server turn when it fires.
- A session whose harness stream ended without a result stayed `running` forever, and when the Codex app server died between turns the next prompt was dropped. The session now fails with the reason as soon as the backend is gone, and the next message resumes it.
- Closing or aborting an OpenCode session did not abort its in-flight turn on the shared server.
- A question left over from a failed or aborted OpenCode turn swallowed the next prompt as its answer. It is cleared when its turn ends.
- Claude Code questions were posted twice (an AskUserQuestion prompt and the waiting notice).

- A worktree decision whose Merge, Open PR / Sync PR, or Discard failed (for example on a rebase conflict) left its buttons in place, but the clicked button was already used, so a retry answered "This action is stale or has already been used". After a failed action OCA now sends the still-open decision again with fresh buttons (Telegram and Discord) and, once that message is delivered, clears the spent controls and retires the older buttons; if it cannot be delivered, the original buttons stay usable. A merge that handed its conflicts to a resolver session is in progress and is not re-offered.
- One button clicked in two runtimes that share a session index (for example an old runtime still stopping during a hot reload) could act twice when both saves were deferred behind the index lock: each writer's merge kept its own consumption. The first consumption persisted now wins the merge, and the other click reports the button as used. This covers the buttons that are consumed before they act (worktree, repo-policy, plan-offer, session, and plugin-update buttons); plan and question buttons keep their per-session serialization and state checks.
- Plugin-update buttons (**Update now**, **Restart Gateway**, **Remind me later**, **Dismiss**) and their version were dropped when the session store reloaded, so they answered "stale" after a Gateway restart. The store now keeps every action kind; the list is checked against the action-kind type.
- A Claude Code `AskUserQuestion` prompt that was answered (or superseded) while its buttons waited to be persisted was still sent with buttons that no longer applied. It is now skipped, as Codex and OpenCode question prompts already were.
- A Gateway stop during a button-driven Merge or PR threw inside `agent_merge` / `agent_pr` once the shared SessionManager reference was cleared, so a merge that landed in git was never recorded as merged. Both tools now keep the manager they started with.
- Text answers to Codex and OpenCode questions sent an option number as the literal answer: replying `2` answered "2" instead of the second option. Every harness now maps text replies the same way (option label or number, comma-separated picks for multi-select, otherwise free text), and OpenCode receives option labels as its API expects. An empty reply or an option number outside the list is rejected with the question shown again instead of reaching the agent; an empty reply no longer declines a Codex approval request.
- OpenCode permission requests could be answered only with buttons: a text reply through `agent_respond` was queued behind the blocked turn and never answered the request. Text replies now map to Allow once / Always allow / Reject (`yes`, `always`, `no`, or the option number), and other text rejects the request with the text as its message.
- The buttons on a Claude Code `AskUserQuestion` prompt failed with "Could not submit that answer" because they were minted before the session saw the question's request id. The harness now passes the request id to the prompt.
- A question button pressed after the question was answered another way, timed out, or cancelled replied "The question prompt is still active; try again". It now says the question is no longer waiting. A question button for a session that was idle-suspended no longer reports the answer as delivered to the stopped backend; it resumes the session with the answer. A Claude Code question that times out is now declined with a clear message to Claude instead of failing the tool call.
- A Gateway restart silently rejected every plan waiting for approval, so Approve after the restart reported the button as stale. A shutdown now keeps the plan decision, and Approve / Revise / Reject resume the session as after an idle suspension. `agent_kill` still rejects the plan.
- A revised plan submitted within 5 seconds of the previous plan prompt was never shown to the user: the waiting-for-input debounce treated it as a repeat. The debounce is now per plan version.
- Plan escalation (now `agent_escalate(kind="plan")`) refused `approve`-mode plan reviews ("already uses direct user plan approval"), although the approve-mode wake tells the orchestrator to send risky plans to the user with it. Only `ask` mode, where the user already has the prompt, is refused now.
- Worktree decision buttons acted on decisions that were already settled: Discard after Merge relabeled the merged worktree as discarded, and Merge after Discard failed with a raw `git checkout` error. Such buttons now reply that the decision was already resolved and do nothing.

- Buttons could answer "⚠️ This action is stale or has already been used." for a prompt that was still current (seen on a pre-launch repo-policy prompt). OpenClaw loads a plugin once per plugin registry, each time as its own module graph, and every copy built its own `SessionManager` over the same session index: tokens minted where the orchestrator's tools ran were missing where Telegram callbacks were dispatched, and each copy rewrote the index from its own memory, which could drop the other's sessions, tokens, and repo policies. OCA now keeps one runtime per Gateway process (`SessionManager`, goal controller, auto-updater, timers, and maintenance) that every registry attaches to. It always uses the newest live registry's host handles, and a newer build takes over only after the old runtime stopped. A newer registration whose effective runtime settings differ (`maxSessions`, `maxPersistedSessions`, `autoUpdate`) rebuilds the runtime with them, and a build that was taken over from never starts again. As defense in depth, token and session lookups re-read the index when another writer changed it, saves take a lock file (deferring, never blocking, while another writer holds it) and merge with that writer's changes instead of overwriting them (backing up a file they cannot merge), and a session another live process runs (running rows now record their owner) is never recovered, resumed, or acted on. Token misses are logged at debug level with the runtime instance and store revision (see REFERENCE "Troubleshooting").
- Running a test file directly (`node --import tsx --test tests/x.test.ts`, tsx, or an IDE) instead of through `scripts/run-tests.mjs` wrote fixture sessions, `.legacy-*.json` archives, and output files into the real `~/.openclaw`. Every test file now imports `tests/test-env.ts` first (enforced by `pnpm check-static-guardrails`). It points `OPENCLAW_HOME`, `OPENCLAW_STATE_DIR`, and the OS temp dir at a fresh temporary directory, reusing only the per-file home `run-tests.mjs` names in `OPENCLAW_CODE_AGENT_TEST_HOME`. Under `node:test`, the session store, goal store, output files, and auto-update state also refuse to write inside the account's real state dir. Scripts may import only `src/harness/**` from `src/`. See `docs/DEVELOPMENT.md` "Test Isolation".
- The asynchronous-launch refusal named "session, delivery, and workspace identity" as missing even when a session key was passed. It now names exactly what is missing: a delivery route, a delivery target for a known channel, or a session key and delivery route.
- `agent_worktree_status` printed `Lifecycle:active` with no space; all fields now share one aligned column after `Label: `.
- Follow-ups sent while a Codex or OpenCode turn was running were dropped: the harness pulled the prompt before the session applied the turn's completion, so the session completed as done (OpenCode never received the message even though `agent_respond` reported it sent). The harness now defers the turn result to the queued turn, and the session also counts pulled prompts against started turns, so a follow-up always starts the next turn.
- Claude Code `AskUserQuestion` can be answered through `agent_respond` (option numbers, labels, multi-select, free text) instead of deadlocking behind the blocked tool call.
- System-event fallbacks no longer drop the origin session key: they always target the session's origin key, and are skipped with a warning (instead of going to the bare `main` session) when there is none.
- The `manual` worktree strategy no longer deletes the worktree when the session completes; it keeps it with a `provisioned` lifecycle and a real timestamp. Legacy rows synthesized without timestamps are dated from the row instead of 1970-01-01.
- Maintenance treats a worktree directory that is already gone as removed and clears its metadata, instead of warning on every tick; repo-root resolution for a missing worktree no longer runs git inside the missing path.
- Claude Code sessions stay running while SDK background tasks are still live after a turn.
- A `gh --version` (or `git --version`) availability probe that times out, for example on a cold host, is cached for only 60 s instead of disabling the CLI for the whole process; a missing binary is still cached.
- Deleting a branch that is already gone counts as success; squash merges are reported as squash commits; `auto-pr` and PR sync skip `gh` when no remote points at a GitHub host `gh` can serve (github.com, `GH_HOST`, or a host in `gh`'s `hosts.yml`), so GitHub Enterprise keeps working while local-path, GitLab, and other remotes no longer trigger `gh` calls.
- Tools that send a user prompt (repo policy, worktree decision) report whether it was delivered instead of always saying it was sent.
- Goal status for one task (now `agent_goal(action="status", task)`) shows only the matching goal; `agent_stats` counts sessions from the persisted store instead of per-process counters; a Claude fork reports only its own cost; `agent_output` separates consecutive Codex and OpenCode messages and shows a pending Claude plan (read from the plan file the session itself wrote when `ExitPlanMode` carries no plan text).
- A plain "Reject" on a pending plan always rejects it, also when sent by the orchestrator without `userInitiated`.
- Routine lifecycle and Codex RPC diagnostics log at info/debug instead of warn, and an interrupt that fails because teardown already aborted the query is no longer reported.
- LLM-generated worktree decision summaries, question context summaries, and PR metadata now call `api.runtime.llm.complete` with the required `messages`, `systemPrompt`, `purpose`, and `maxTokens` and parse `LlmCompleteResult.text`; previously every call failed and silently used the deterministic fallback. Speculative probing of `runtime.ai`, `runtime.model(s)`, and other nonexistent surfaces is removed. Question context summaries get a 5 s budget (previously 300 ms) and abort the host completion when it expires.
- OpenCode multi-question requests now send one answer list per question instead of packing every answer into one string.
- Claude Code plan mode no longer denies `ExitPlanMode` itself (since SDK 0.3.269 plan mode routes that tool through `canUseTool`), so Claude no longer sees its plan submission rejected.
- Claude Code results that report `is_error` on a `success` subtype are failures, and a turn aborted by `agent_respond(..., interrupt=true)` is an interrupted turn rather than a failed session.
- Claude Code results are no longer emitted while `queued_turn_count` says more queued user turns follow, so a queued follow-up can no longer end the session early. Empty background-notification results are recognized by `origin` instead of a zero-turn heuristic.
- Claude Code startup failures are always reported; previously a failure before the first message could be dropped when the event stream closed first.
- OpenCode reports each tool call once, with its input, instead of on every tool-part update.
- Codex system prompts (including the worktree preamble) and reasoning effort were silently dropped: collaboration settings were sent camelCase. The system prompt is now thread `developerInstructions`, effort is the turn `effort` plus snake_case `reasoning_effort`, and built-in plan/default mode instructions stay active.
- Codex fast mode was a no-op (`service_tier` is not a protocol field); it now requests `serviceTier: "priority"`, and the fast cost multiplier applies only when Codex reports the priority tier.
- Codex API-key cost now comes from `thread/tokenUsage/updated` (the previous `rawResponse/completed` source is not emitted to normal clients).
- Codex resume no longer hydrates full thread history (`excludeTurns: true`; `persistExtendedHistory` no longer exists).
- Codex server requests OCA cannot serve (`mcpServer/elicitation/request`, `item/tool/call`, `account/chatgptAuthTokens/refresh`, unknown methods) now get protocol-correct decline/error responses instead of `{}`; approvals answer with typed decisions and `serverRequest/resolved` releases the pending prompt.
- Codex turn outcomes come only from `turn/completed` `turn.status`; removed the nonexistent `thread/new`, `turn/failed`, and `turn/cancelled` paths and the method-fallback retry loop. The thread is started/resumed once per connection instead of before every turn, and an app-server exit fails the active turn instead of hanging.
- `agent_repo_policy(reset=true)` and `/agent_policy reset` found nothing once the repo directory was deleted, because the stored key includes the remote URL, which was read from the live checkout. Reset, and the status view, now also match stored records by repo path (including a path inside the deleted repo) or by the stored key; `/agent_policy reset <path>` targets another repo; `list` marks policies whose repo is gone with `(missing)`. When the repo still exists, reset also removes records left at the same path under an older remote.
- Session store rows kept the host's whole managed Task Flow record as `taskFlowMirror` (goal text, state and wait JSON, timestamps) until the next load trimmed it. OCA now keeps only `flowId`, `revision`, `status`, and `cancelRequestedAt`.
- `agent_pr` retried every failed `gh pr create` without `--draft` and, when the retry worked, reported "Target repo does not support draft PRs". The draft heuristic matched `--draft` in the failed command line that the error message echoes; it now reads only gh's error output, and failures report gh's message instead of the full command with the PR body.
- Session keys of the `per-account-channel-peer` DM scope (`agent:<agent>:<channel>:<account>:direct:<peer>`) produced undeliverable routes: Telegram notifications went to the target `direct:<peer>` even when the origin channel named the right chat, and Discord DMs went to `channel:<peer>` instead of `user:<peer>`. OCA now reads the account segment (also for accounts named like a peer kind, as the host does), and uses it as the route account when the key is the only route source.
- Launch resolution read only Telegram `:topic:` suffixes from the origin session key, so a session launched from a Discord or Slack thread recorded no origin thread unless the tool context also carried the thread id. It now reads the host's `:thread:` suffix too, as a string (Discord thread ids exceed JavaScript's safe integers, and Slack thread ids are timestamps).
- A multi-select answer that named an option whose label contains a comma (for example "Yes, continue") was split at the comma and sent as two free-text answers. Labels that contain commas or newlines now select their option; when a reply also splits into existing options (`A`, `B`, and `A, B`), the separate options win, and the combined one is picked by number.
- A 4.x store row without `worktreeLifecycle` whose `completedAt` or `createdAt` was outside the JavaScript date range made the store load throw, which archived and reset the whole session store as corrupt. Such timestamps are now ignored when the lifecycle is synthesized.
- Route canonicalization treated a blank route `sessionKey` as a key, which hid the session's origin key until the next store load dropped the blank value. A blank key now counts as absent right away.

### Decisions

- Telegram `:topic:` session-key parsing stays local: the SDK topic helpers are private, and `parseAgentSessionKey` lower-cases peer ids.
- The self-updater stays: `openclaw plugins update` on 2026.9.6 cannot move a ClawHub install to a specific version, so OCA keeps its exact-version reinstall behind button confirmation (now switchable with `autoUpdate`).
- Worktree-decision reminders keep in-process timers: the public session scheduler only records cleanup metadata and host cron jobs cannot run plugin callbacks.
- Claude Code `rewindFiles` is not used: it needs SDK file checkpointing held only in the Claude Code process, and OCA worktrees can already be reset or discarded with git.
- `.openclaw/worktree-setup.sh` runs for OCA worktrees, unlike OpenClaw core, which runs it only for admin-scope callers of `worktrees.create`. Because the orchestrator model fills in the launch `workdir`, OCA runs only the version committed on the base branch, with a minimal environment, and asks the user before a merge that changes it. The script still runs unsandboxed with the Gateway user's filesystem privileges (which can be more than a `:workspace` Codex session has).
- The Codex default model (`gpt-6-sol`) and allowlist stay static operator policy rather than following `model/list` `isDefault`: the allowlist check runs before launch, when no catalog is loaded, and a catalog default that moves with Codex upgrades would silently change, and possibly disallow, the default model.
- `autoUpdate` is not listed in the manifest `dangerousFlags`: those flags match explicitly configured values, and `true` is the default, so the flag could not describe the default state.
- Goals: OCA keeps its cross-harness, verifier-driven goal loop and does not map Codex sessions onto native `thread/goal/*`.
- Pre-PR review stays an explicit `agent_session_action(action: "review")` step rather than an automatic worktree-PR hook.
- The `ultra` Codex effort is not exposed yet because OCA's effort enum is shared with Claude Code.
- Stored repo policies whose directory is gone are not pruned automatically. The directory may be missing only for a while (an unmounted volume, a re-clone at the same path, which reuses the policy), and the records are small; `agent_repo_policy(cleanup=true)` / `/agent_policy cleanup` remove them on request.
- Claude Code sessions still update their cost only when a turn completes: the SDK reports cost in its per-turn `result`, and its only mid-turn cost read (`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`) is marked unstable.
- pnpm's `minimumReleaseAge` stays `0`. pnpm 11 checks every lockfile entry against the window at install time, including frozen CI and release installs, so a 3-day window would block the same-day OpenClaw compatibility updates a release depends on (and the Claude SDK's per-platform packages) unless each release carried exact-version exclusions. Dependabot's cooldown delays automated updates instead, and manual bumps prefer releases older than 3 days.

## [4.7.20] - 2026-09-24

### Added

- Allow `gpt-6-luna` in the built-in Codex model allowlist alongside `gpt-6-sol` and `gpt-6-astra`, matching the Codex App Server's GPT-6 catalog. The GPT-5.6 Sol, Terra, and Luna overrides remain allowed.
- Estimate API-key Codex charges for GPT-6 Sol ($2 input, $0.20 cached input, $10 output per 1M tokens) and GPT-6 Luna ($0.10, $0.01, $0.50) from OpenAI's published standard rates, with the existing cache-write, long-context, and Fast mode multipliers. Unlisted GPT-6 snapshots stay unpriced.

## [4.7.19] - 2026-09-23

### Changed

- Target OpenClaw and Plugin SDK `2026.9.6`, requiring `>=2026.9.6` for managed installation while retaining the verified `2026.8.1` plugin API, Gateway, and peer compatibility floor.
- Verify plugin tools, commands, and service reload, Codex and Claude Code model restrictions, Start Plan and approval behavior, Telegram/topic callbacks, completion and cron/session wake delivery, runtime allowlists, disabled bundled-plugin boundaries, and managed worktree/auto-PR flows against OpenClaw `2026.9.6`.
- Document structured Tool Search, Telegram text batching, requester-owned background sessions, improved scheduled delivery, host model additions, and the optional GitHub reader allowlist entry without changing host configuration.

## [4.7.18] - 2026-09-23

### Fixed

- Use Claude Code's native `opus` alias for new default launches. Reject the unsupported `anthropic/claude-opus-5-5` spelling with an actionable error when it remains in explicit or legacy configuration; other model overrides remain unchanged.

## [4.7.17] - 2026-09-23

### Changed

- Target OpenClaw and Plugin SDK `2026.9.5`, requiring `>=2026.9.5` for managed installation while retaining the verified `2026.8.1` plugin API, Gateway, and peer compatibility floor.
- Verify plugin tools, commands, and service reload, Codex and Claude Code model restrictions, Start Plan and approval behavior, Telegram/topic callbacks, completion and cron/session wake delivery, runtime allowlists, disabled bundled-plugin boundaries, and managed worktree/auto-PR flows against OpenClaw `2026.9.5`.
- Document live plugin reload, private completion handoffs, Telegram policy reload, scheduled-delivery correctness, Gateway V2 node transport boundaries, and the deprecated model-policy `allowsKey` surface without migrating host configuration.
- Migrate TaskFlow mirroring to `tasks.async.managedFlows`, preserving lifecycle event order and awaiting recovery, terminal persistence, and shutdown completion. Older compatible hosts without the async managed-flow mutations keep mirroring disabled through structural detection.
- Default new Codex launches to the App Server catalog's canonical `gpt-6-sol` model at its supported `medium` reasoning default, and default new Claude Code launches to Claude Code's canonical `anthropic/claude-opus-5-5` model while preserving explicit model overrides and the existing harness-scoped allowlists.

## [4.7.16] - 2026-09-10

### Changed

- Target OpenClaw and Plugin SDK `2026.9.4`, requiring `>=2026.9.4` for managed installation while retaining the verified `2026.8.1` plugin API, Gateway, and peer compatibility floor.
- Verify plugin tools and commands, Codex and Claude Code model restrictions, Start Plan and approval callbacks, Telegram/topic routing, completion and cron/session wake delivery, runtime allowlists, disabled bundled-plugin boundaries, and managed worktree/auto-PR flows against OpenClaw `2026.9.4`.
- Document OpenClaw's unified plugin workspace, prepared plugin-tool ownership, delivery-context and Telegram approval changes, and dated SDK deprecations without migrating host configuration.

## [4.7.15] - 2026-09-08

### Changed

- Target OpenClaw and Plugin SDK `2026.9.3`, requiring `>=2026.9.3` for managed installation while retaining the verified `2026.8.1` plugin API, Gateway, and peer compatibility floor.
- Require Node `>=24.16.0 <25 || >=26.1.0`, target Node 24 bundles, and validate both supported Node release lines in CI.
- Verify plugin tools and commands, Codex and Claude Code model restrictions, Start Plan and approval callbacks, Telegram/topic routing, completion and cron/session wake delivery, runtime allowlists, disabled bundled-plugin boundaries, and managed worktree/auto-PR flows against OpenClaw `2026.9.3`.
- Document OpenClaw's durable session and scheduled-delivery recovery, forum-topic isolation, managed worktree readiness, and agent-owned Workshop behavior without migrating host configuration.

## [4.7.14] - 2026-09-06

### Changed

- Target OpenClaw and Plugin SDK `2026.9.2`, requiring `>=2026.9.2` for managed installation while retaining the `2026.8.1` plugin API, Gateway, and peer compatibility floor.
- Verify plugin tools, harness restrictions, plan approval, worktree strategies, Telegram/topic callbacks, completion and cron/session wake delivery against OpenClaw `2026.9.2`.
- Document experimental SDK stability, cross-agent visibility controls, and plugin-owned model, approval, delivery, and worktree contracts without migrating host configuration.

### Fixed

- Show the known session reasoning level consistently in launch, approval/progress, terminal and manual/worktree notification headings, preserving saved settings after restart and resume/fork instead of consulting changed defaults.
- Allow an explicit `agent_launch(reasoning_effort=...)` override and retain resumed/forked session effort ahead of harness defaults; omit notification effort for unknown or unsupported harness/model settings.

## [4.7.13] - 2026-09-04

### Changed

- Made `gpt-6-astra` the default Codex harness model while retaining GPT-5.6 Sol, Terra, and Luna as explicit supported overrides.

## [4.7.12] - 2026-09-04

### Changed

- Validated the plugin entrypoint, declared tool capabilities, Codex and Claude Code model restrictions, plan approval and worktree strategy flows, Telegram/topic callbacks, completion and cron/session wake delivery, restrictive namespaced tool allowlists, and disabled bundled-plugin boundaries against OpenClaw `2026.9.1`.
- Updated exact OpenClaw package and Plugin SDK build provenance plus the managed-install minimum to `2026.9.1`, while retaining the verified `2026.8.1` plugin API, Gateway, and peer compatibility floor.
- Documented OpenClaw's renewed plugin capability consent, activatable-harness validation, origin-channel approval delivery, host-managed worktree settings, and cron delivery improvements without performing a host configuration migration.

### Security

- Raised the consumer-enforced `fast-uri` floor to `3.1.6` and added `qs@6.16.0` to the exact published dependency contract, clearing the current production URI-normalization, SSRF, array-limit bypass, and denial-of-service advisories.

## [4.7.11] - 2026-09-02

### Fixed

- Defer Code Agent startup work until after OpenClaw's side-effect-free tool factory enumeration, and deduplicate persisted workdir Git discovery so retained sessions no longer repeat repository probes.

## [4.7.10] - 2026-09-01

### Changed

- Validated the plugin entrypoint, tool contracts, harness model restrictions, plan approval and worktree strategy flows, Telegram/topic callbacks, completion and cron/session wake delivery, runtime tool allowlists, and disabled bundled-plugin boundaries against OpenClaw `2026.8.2`.
- Updated exact OpenClaw package and Plugin SDK build provenance to `2026.8.2` and aligned the managed-install minimum with that build target, while retaining the verified `2026.8.1` plugin API, Gateway, and peer compatibility floor.
- Documented OpenClaw's broader default visibility for unsandboxed same-agent sessions, including retained cron sessions; operators who need narrower isolation can explicitly configure `tools.sessions.visibility`, and this package performs no host configuration migration.
- Removed the repository's publication-age waiting policy and Dependabot cooldowns. Dependency updates now rely on deterministic pnpm/npm lock artifacts, frozen installation, exact-version validation, audits, dependency review, packed-consumer verification, and exact-head review instead of elapsed time.

## [4.7.9] - 2026-08-31

### Changed

- Validated the plugin entrypoint, harnesses, approvals, callbacks, Telegram/topic routing, session restore, worktree/PR policy, wake delivery, tool visibility, and disabled bundled-plugin boundaries against OpenClaw `2026.8.1`, and raised the install, plugin API, Gateway, peer, build, and development target to that release.
- Documented that OpenClaw's host-side `codex/*` and `openai-codex/*` to `openai/*` route migration does not rewrite Code Agent's plugin-owned Codex model names or bypass its harness-scoped `allowedModels`; no host configuration migration is performed by this package.

### Fixed

- Close Codex App Server transports whenever an OCA session becomes terminal, wait for the owned child process to exit, and force-kill it after a bounded grace period. Replacement resumes wait on that teardown barrier, and duplicate resumes fail before launch while a live session still owns the writer, preventing suspended, failed-startup, and replaced sessions from triggering RPC `-32600`.
- Use Codex App Server's `thread/fork` operation once for `fork_session=true` instead of accidentally resuming the source thread, competing for its active writer, or creating a new nested fork on every follow-up turn.
- Keep an accepted plan resume in `awaiting_plan_output` until its backend reaches `running`, so a zero-output resume failure remains retryable and is not falsely persisted or reported as `approved_then_implemented`.

## [4.7.8] - 2026-08-05

### Security

- Declare the patched `fast-uri@3.1.5`, `hono@4.12.34`, and `ip-address@10.3.1` runtime versions as exact package dependencies and ship a machine-checked npm shrinkwrap. npm ignores `overrides` from installed dependencies, so this makes the security floors part of the consumer-resolved dependency contract instead of ineffective published metadata.
- Upgrade the declared MCP runtime to `1.30.0`, pin `@hono/node-server@2.0.10` and `express-rate-limit@8.6.1`, and machine-check the shrinkwrapped runtime dependency graph. This removes the adapter path-traversal advisory while preserving deterministic consumer resolution.
- Remove obsolete Claude SDK dependency exceptions and keep exact runtime dependency and generated-lock validation centralized in repository-owned checks.

### Release

- Retry ClawHub verification with bounded backoff after a successful publish so registry propagation does not strand npm and GitHub publication.

## [4.7.7] - 2026-08-03

### Changed
- Validated and retargeted package and plugin SDK build metadata to OpenClaw `2026.7.1-2`, using that correction release as the install, plugin API, Gateway, and peer dependency floor so both it and stable `2026.7.1` satisfy the declared compatibility contract.
- Confirmed that the OpenClaw correction release's singleton-array npm metadata fix requires no changes to Code Agent tools, callbacks, wake routing, worktree flows, plan approval, or harness model restrictions.
- Pinned patched `fast-uri` and Hono transitive releases and removed the temporary `hono@4.12.34` dependency exception after incorporating the fixed version into normal lock generation.

### Fixed
- Removed production dependency advisories for `fast-uri` URI authority parsing, Hono CORS-header regular-expression denial of service, and `ip-address` special-use classification, plus development-graph advisories in `protobufjs`, `tar`, and `undici`, while retaining exact dependency and lockfile validation.

## [4.7.6] - 2026-07-15

### Changed
- Renamed the user-facing OpenClaw and ClawHub plugin title from "OpenClaw Code Agent" to "Code Agent" while preserving stable package, plugin, and command identifiers.
- Replaced customer-facing "OCA" shorthand with the full "OpenClaw Code Agent" name in update, callback, repository-policy, session, and lifecycle messages.
- Updated the Claude Agent SDK, TypeScript, nanoid, tsx, and pinned GitHub Actions used by CI and release automation.

### Fixed
- Kept approved plugin update, restart, dismiss, and reminder callbacks running when Telegram action-button cleanup fails, while logging the cleanup failure for diagnosis.

## [4.7.5] - 2026-07-14

### Changed
- Upgraded the repository and release workflows to pnpm `11.13.0`, using pnpm's explicit dependency build allowlist so production security audits continue to run with the intended install-script policy.

### Fixed
- Fixed multi-question Codex input requests so each answer consumes only the active question's controls, delivers the next question, and reports when more input is still required.
- Cleared resolved pending-input state after the final answer so completed requests no longer remain visible as awaiting input.

## [4.7.4] - 2026-07-14

### Fixed
- Fixed self-updates on OpenClaw `2026.7.1` by discovering releases from the recorded npm or ClawHub source, reinstalling the exact approved release from that source, and verifying installed plugin discovery plus managed install metadata before offering a Gateway restart.
- Added focused Telegram update-callback diagnostics and regression coverage so plugin-owned handling can be distinguished from callbacks that OpenClaw core never dispatches.

## [4.7.3] - 2026-07-14

### Changed
- Raised the advertised OpenClaw plugin API, Gateway, and peer dependency minimums to `2026.7.1`, keeping ClawHub and OpenClaw install compatibility checks aligned with the release-tested host.

### Fixed
- Fixed token-backed ClawHub publishing to use the CLI's documented temporary configuration file while keeping the repository secret out of artifacts and logs.

## [4.7.2] - 2026-07-13

### Changed
- Kept the daily update checker while delegating confirmed installs to OpenClaw's native updater with the exact approved version, validating canonical stable versions, and bounding registry requests, so pinned installs advance without a moving npm tag changing what the user confirmed.

### Fixed
- Fixed restart-notification failures so they cannot misreport a completed plugin update as failed.
- Fixed release automation to send the exact verified tarball to ClawHub, publish npm tarballs through an explicit local path, retain verified artifacts through delayed environment approval, and attribute the pre-tag ClawHub dry run to the exact commit without claiming a not-yet-created release ref.
- Stabilized closed-helper-PR cleanup regression coverage on slower CI runners.

## [4.7.1] - 2026-07-13

### Changed
- Retargeted the OpenClaw package and plugin SDK validation metadata to `2026.7.1` while keeping the compatible `>=2026.4.21` peer/API floor.
- Refreshed compatibility guidance for OpenClaw `2026.7.1` Codex app-server, Telegram and topic routing, cron/session delivery, approvals, tool allowlists, disabled bundled plugin behavior, completion wakes, model restrictions, and worktree follow-through without requiring host configuration migration.
- Updated the packed-plugin install smoke for OpenClaw's operator-owned `security.installPolicy` model, isolated all home and XDG paths, and retained a failing deep static-audit gate for any unreviewed dangerous-code finding.

### Fixed
- Fixed agent-created pull requests losing the completed Codex report when runtime PR metadata generation is unavailable; OCA now builds and posts task-specific title/body metadata from bounded, redacted session output.
- Reconciled existing fork PR updates performed from isolated worktrees against the authoritative remote PR head, preventing stale helper-branch pushes and bogus follow-up decisions.

## [4.7.0] - 2026-07-09

### Added
- Added operator-controlled plugin update prompts that detect newer published versions and support in-chat install/restart follow-through.
- Added live Codex Telegram proof tooling with credential leasing, bounded response capture, artifact redaction, and safe dry-run coverage.

### Changed
- Updated the built-in Codex harness default from the GPT-5.5 family to `gpt-5.6-sol` and restricted the built-in allowlist to `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`.
- Renamed explicit goal chat commands and public goal tools to the `agent_goal*` namespace, avoiding Telegram command conflicts and making the tool surface consistent with the rest of OpenClaw Code Agent.

### Fixed
- Reused and refreshed existing pull requests during worktree follow-through, including resilient metadata fallback, instead of creating duplicate sibling PRs.
- Clarified resumed-session and clean-worktree update notifications while preventing duplicate auto-resume and completion follow-ups.

## [4.6.0] - 2026-07-02

### Added
- Added deterministic Codex-first integration coverage for the Crabbox proof path and plugin workflow handoffs, including no-live-credential guards, fake native orchestration, artifact redaction/staging/cleanup, existing-PR branch reuse, sibling PR rejection, TaskFlow mirror reconciliation, and release metadata drift checks.
- Added the `pnpm test:integ:crabbox` validation target for the Codex proof, Crabbox, Telegram proof, app-server, and plugin workflow integration suites.

### Fixed
- Classified harness startup authentication and credential failures as failed sessions even when a backend reports a nominal completion, preserving the failure line in session state and user-facing completion output.
- Normalized terminal, merge, PR opened/updated, and no-change notification stats so known cost, duration, harness, and model details render consistently across worktree follow-through outcomes without leaking unsanitized PR wake data.

## [4.5.9] - 2026-07-01

### Added
- Added guarded Codex-only Telegram proof orchestration with explicit live gates, credential lease handling, deterministic dry-run planning, public artifact staging, and redaction so release proof paths can be validated without sending Telegram messages, acquiring real credentials, restarting Gateway, or driving Desktop automation by default.

### Fixed
- Fixed `agent_pr` follow-up sessions that already reference an existing target PR so safe helper-branch updates fast-forward the original PR branch instead of opening a sibling PR, while divergent helper branches are rejected.
- Fixed TaskFlow mirror reconciliation so terminal task state is normalized, restored, and cleared consistently across session storage, active session sync, lifecycle transitions, and manager summaries.

## [4.5.8] - 2026-07-01

### Fixed
- Prevented duplicate helper PR follow-through by resolving existing PR state before offering or creating another PR, preserving correct worktree lifecycle cleanup for branch content that already has an associated PR.
- Sent resumed `agent_launch` sessions as distinct `▶️ [name] Resumed` notifications and made resumed launch, auto-resume, terminal completion, and terminal worktree notification idempotency cycle-aware so later legitimate lifecycle events are not suppressed as duplicates.

### Changed
- Isolated test runs from the live OpenClaw Code Agent session store by default so local verification cannot mutate operator session state.
- Refreshed lockfile resolutions for `@types/node`, `@anthropic-ai/claude-agent-sdk`, and `nanoid`.

## [4.5.7] - 2026-06-30

### Changed
- Retargeted the OpenClaw package and plugin SDK validation metadata to `2026.6.11` while keeping the compatible `>=2026.4.21` peer/API floor.
- Refreshed OpenClaw `2026.6.11` compatibility guidance for the updated SDK API baseline, new `openclaw/plugin-sdk/agent-harness-tool-runtime` export boundary, current callback/completion behavior, cron/session delivery behavior, yielded output/media preservation, plugin tool allowlists, and OCA-owned plan, wake, Codex harness, and worktree follow-through flows.

## [4.5.6] - 2026-06-26

### Fixed
- Treated Telegram `message is not modified` reply-markup cleanup responses as idempotent during plan approval callbacks so already-cleared buttons do not block approval execution from resuming.

## [4.5.5] - 2026-06-24

### Changed
- Retargeted the OpenClaw package and plugin SDK validation metadata to `2026.6.10` while keeping the compatible `>=2026.4.21` peer/API floor.
- Refreshed OpenClaw `2026.6.10` compatibility guidance for fast-talk state persistence, session/channel routing, cron delivery awareness, trusted hook policies, provider model routing, setup registry refresh, Codex/Claude harness model restrictions, plugin tool allowlists, disabled bundled plugin behavior, pnpm workspace metadata, and OCA-owned plan, callback, wake, completion, and worktree follow-through flows, including the latest stale plan approval retry-button and serialized callback fixes.

## [4.5.4] - 2026-06-21

### Changed
- Retargeted the OpenClaw package and plugin SDK validation metadata to `2026.6.9` while keeping the compatible `>=2026.4.21` peer/API floor.
- Refreshed OpenClaw `2026.6.9` compatibility guidance for installed channel plugin discovery, official provider package externalization, declared tool allowlists, plugin write ownership checks, manifest/package metadata contracts, cron/tool behavior changes, yielded media/completion handling, default cron `runMode="due"` behavior, and the current-main callback/follow-up fixes for native callback data, delayed/raw callback handling, serialized plan decisions, retryable token consumption, and PR update summary dedupe.

## [4.5.3] - 2026-06-19

### Fixed
- Normalized Codex model aliases before launch validation so configured defaults, launch requests, and Codex app-server model arguments resolve consistently.
- Preserved stale released worktree reminders when released evidence exists but cleanup still needs a user decision, keeping follow-up actions visible for old completed sessions.

### Changed
- Pinned vulnerable transitive `tar` ranges to `7.5.16` through pnpm overrides so production audits use the patched release.

## [4.5.2] - 2026-06-18

### Fixed
- Guarded Codex App Server resume attempts so plugin-owned session IDs are not sent as backend thread IDs; invalid resume IDs now start a fresh Codex thread instead of failing the app-server resume path.
- Hardened Codex App Server startup by defaulting launches to the stdio listener, extending request timeouts, and including redacted recent stderr in timeout diagnostics.
- Kept pending worktree decision reminders policy-aware when repository policy state is unavailable, preserving Merge/Open PR/Later/Discard actions instead of hiding valid follow-through buttons.
- Updated the Hono production audit override to `4.12.25` so the OpenClaw `2026.6.8` dependency tree stays clear under `pnpm audit --prod`.

### Changed
- Retargeted the OpenClaw package and plugin SDK validation metadata to `2026.6.8` while keeping the compatible `>=2026.4.21` peer/API floor.
- Refreshed OpenClaw `2026.6.8` compatibility guidance for richer Telegram delivery, WhatsApp ACP bindings, Codex startup/resume hardening, worktree decision follow-through, agent/Gateway recovery, provider/model replay hardening, usage footer hooks, managed plugin update repair, and release/test reliability.

## [4.5.1] - 2026-06-12

### Changed
- Retargeted the OpenClaw package and plugin SDK validation metadata to `2026.6.6` while keeping the compatible `>=2026.4.21` peer/API floor.
- Refreshed OpenClaw `2026.6.6` compatibility guidance for wake routing, Telegram topic callbacks, cron/session delivery, runtime tool allowlists, bundled plugin boundaries, Codex/Claude harness model restrictions, and managed worktree follow-through.

## [4.5.0] - 2026-06-12

### Added
- Added repository integration policies for managed worktree sessions, including policy storage, chat/tool commands, policy-aware worktree buttons, and deferred launch continuation after the user chooses how OCA may integrate with a repository.
- Added repo-policy choice buttons for unknown repositories and preserved the original launch context through manual or button-based policy selection.
- Added the built-in `oca` natural-language alias for OpenClaw Code Agent sessions.
- Added structured pending-input option handling so Codex and other harnesses can present compact question buttons while preserving full option semantics.

### Fixed
- Fixed worktree decision prompts so successful Merge/Open PR actions clear the original buttons without posting duplicate selection acknowledgements, while merge and PR outcome summaries remain authoritative.
- Fixed stale plan, pending-input, legacy question, repo-policy, and manual policy continuation callbacks so old buttons cannot affect newer review state or duplicate launches.
- Fixed repo-policy handling in resolver failures, reminders, fallback buttons, and restored sessions so live policy is respected consistently.
- Fixed cross-repository PR head lookup and agent merge cleanup reporting.
- Serialized OpenCode server startup to avoid shared SQLite lock failures.
- Preserved deferred repo-policy worktree strategy, cleared stale manual repo-policy prompts, and rescheduled no-op action-token expiry purges so deferred button state cannot strand later token deadlines.
- Sanitized rendered Telegram inline button callback payloads so invalid callback data cannot reach Telegram delivery.
- Cleared consumed Start Plan buttons when plan-offer launch fails so the chat does not leave a stale retry action visible.

### Changed
- Improved worktree decision summaries with concise implementation details and shorter button rows.
- Agent-created PRs now open as drafts by default.
- Updated OpenClaw, Claude Agent SDK, and Node type dependencies.

## [4.4.2] - 2026-06-07

### Fixed
- Fixed recovered persisted-only sessions so `agent_kill` can dismiss interrupted records without reporting a missing live session.
- Fixed OpenCode turn completion detection so stable assistant output or SSE idle events can complete a turn when classic status polling times out or remains busy.
- Fixed already-merged auto-merge worktrees so ancestry-merged branches are marked merged instead of flagged as suspicious base advancement.
- Preserved active or dirty worktree lifecycle state while recording repository-derived merged/released evidence, avoiding premature cleanup decisions.

## [4.4.1] - 2026-06-07

### Added
- Added static guardrails for source-level explicit `any`, unused private methods, goal command/tool drift, PR metadata safety placement, and notification diagnostic gating.
- Added grouped session state snapshot helpers for approval, worktree, backend, and routing state so persistence paths can consume stable typed state groups.

### Fixed
- Fixed session control patch semantics so explicit `undefined` clears optional active-session fields while omitted persisted patch fields preserve live state.
- Fixed persisted-to-active state sync so approval prompt fields, completion wake fields, and pending worktree decision fields clear deterministically without accidental drift.
- Stabilized OpenCode startup readiness retries so a timed-out `/api/health` probe is isolated and later startup probes can still succeed.
- Gated notification decision stderr diagnostics behind opt-in diagnostics configuration while preserving testable decision logs.

### Changed
- Moved `SessionManager` service assembly into an internal factory while keeping `SessionManager` focused on orchestration entrypoints.
- Consolidated goal status, stop, and edit rendering through a shared application layer used by both tools and chat commands.
- Moved generated PR metadata evidence, redaction, schema validation, prompt-leak checks, and body formatting out of `agent_pr` into a dedicated PR metadata module.
- Migrated metrics and lifecycle coverage away from private `SessionManager` compatibility wrappers and hardened guardrails so those wrappers do not return.

## [4.4.0] - 2026-06-06

### Added
- Added experimental OpenCode harness documentation, manifest guidance, and smoke-test instructions for the local `opencode serve` integration.
- Added experimental OpenCode harness support so `agent_launch`, `agent_goal_launch`, resume handling, plan gating, worktree strategies, and session storage can run through `opencode`.
- Added `agent_request_worktree_decision` as a tool contract so orchestrator wakes can request a state-aware worktree decision prompt without relying on chat commands.

### Fixed
- Allowed OpenCode launches and goal tasks to omit a plugin default model so OpenCode can use its configured provider default.
- Externalized the canonical OpenClaw plugin SDK entry helper from the bundled release artifact to keep bundle size comfortably below the CI limit.
- Fixed OpenCode compatibility with v2 API routing, API-prefixed server routes, managed readiness retries, and classic session lifecycle handling while v2 session wait remains unavailable.
- Fixed OpenCode turn-idle detection so sessions wait for stable assistant completion instead of timing out while backend activity has already settled.
- Hardened completion-summary ownership and notification idempotency so goal, terminal, delegated worktree, PR, and routed wake paths collapse duplicate user-visible summaries while preserving retryable delivery state.
- Fixed delegated worktree notification follow-through, duplicate goal completion statuses, foreground goal summary dedupe, duplicate Later snooze confirmations, and duplicate PR/worktree follow-up summaries.
- Removed LLM-marker-based completion follow-up dedupe as the source of truth; delivery state and semantic outcome identity now govern whether a follow-up should be retried or suppressed.

### Changed
- Session and launch surfaces now include clearer harness/model labels using `harness | model` formatting where the launch status needs both values.
- OpenCode docs now describe the experimental harness as a localhost `opencode serve` integration using OpenCode's configured provider default unless a launch passes an explicit `provider/model`.

## [4.3.8] - 2026-06-04

### Added
- Added `agent_goal_edit` support so active goal tasks can be refined without relaunching the surrounding workflow.
- Added goal iteration summaries so goal progress updates preserve a concise account of what changed between iterations.

### Fixed
- Deduplicated goal-owned terminal completion follow-up wakes so goal success and terminal completion paths collapse to one routed human summary while preserving the canonical plugin status line.
- Deduplicated PR/worktree follow-up summaries using the resolved notification route and material PR outcome key, while still allowing later PR updates with new commits to produce a fresh summary.
- Persisted and restored `goalTaskId` for worktree notification targets so restored goal-owned flows keep the same terminal outcome key after restart or reroute.

### Changed
- Refreshed ACP comparison guidance for current Codex chat binding and explicit ACP routing behavior.

## [4.3.7] - 2026-06-03

### Fixed
- Treated summaries inside `agent_output(session, full=true)` as source material rather than visible delivery, so completion follow-up wakes still post a short routed summary when the user only saw the canonical plugin status line.
- Rejected the stale `COMPLETION_FOLLOWUP_SKIPPED: already summarized by completed session` marker so incomplete completion follow-ups remain retryable instead of being silently cleared.
- Suppressed generic terminal completion notifications after worktree strategy handling already sent an authoritative merge or PR outcome notification, preserving the contract of canonical plugin status plus at most one orchestrator-owned human summary.

## [4.3.6] - 2026-06-03

### Fixed
- Fixed duplicate completion follow-up summaries by releasing completion wake keys on notify-only exits and bounding the completion wake dedupe cache.
- Fixed Start Plan button cleanup so consumed, missing-context, and retried plan-offer callbacks clear the original prompt without surfacing raw callback text.

### Changed
- Updated the local OpenClaw package target to `openclaw@2026.6.1` while keeping the peer and plugin API floors at `>=2026.4.21`.
- Kept the rebased release lockfile on `@anthropic-ai/claude-agent-sdk@0.3.162` and `tsx@4.22.4` from the current `main` dependency baseline.
- Documented the `2026.6.1` compatibility verdict: no plugin source migration was required because `openclaw-code-agent` still imports only `openclaw/plugin-sdk/plugin-entry`, declares its tool surface through `contracts.tools`, and owns its own session store, wake routing, callbacks, worktree flows, and harness model restrictions.
- Refreshed operator guidance for plugin install/index lookup, approval callback behavior, Telegram/topic routing, cron-origin wake delivery, Codex/Claude harness policy boundaries, runtime tool allowlists, disabled bundled plugin behavior, and worktree `delegate`/`ask`/`auto-pr` follow-through under OpenClaw `2026.6.1`.

## [4.3.5] - 2026-06-01

### Fixed
- Hardened Telegram interactive callback handling for OpenClaw `2026.5.28` by accepting the current native callback shape when `callback.payload` is absent and only the full `callback.data` value is provided.
- Deferred OCA worktree outcome follow-up wakes until after merge or PR terminal status is visible, so the orchestrator reads the canonical outcome before sending the routed summary.
- Made OCA completion follow-up wake retries crash-safe and semantic: persisted retry state survives restarts, and `completionWakeSucceededAt` is recorded only after visible follow-up delivery is proven.

### Changed
- Kept the local OpenClaw package target on `openclaw@2026.5.28` while retaining the peer and plugin API floors at `>=2026.4.21`.
- Refreshed release compatibility guidance for OpenClaw `2026.5.28`, including callback/API hardening, runtime tool allowlists, and Codex/Claude harness policy boundaries.

## [4.3.4] - 2026-05-31

### Fixed
- Hardened Telegram interactive callback handling for OpenClaw `2026.5.28` by accepting the current native callback shape when `callback.payload` is absent and only the full `callback.data` value is provided.
- Added regressions for Telegram forum-topic Start Plan, Dismiss, plan-approval, and unauthorized callback flows so `code-agent:<token>` button payloads are consumed by OCA instead of surfacing as raw chat text.

### Changed
- Updated the local OpenClaw package target to `openclaw@2026.5.28` while keeping the peer and plugin API floors at `>=2026.4.21`.
- Documented the `2026.5.28` compatibility verdict: no plugin source migration was required because `openclaw-code-agent` still imports only `openclaw/plugin-sdk/plugin-entry`, declares its tool surface through `contracts.tools`, and owns its own session store, wake routing, callbacks, worktree flows, and harness model restrictions.
- Refreshed operator guidance for per-plugin npm install roots, `openclaw.compat.pluginApi` package selection, Telegram/topic routing, Start Plan and approval callbacks, cron-origin wake delivery, Codex/Claude harness policy boundaries, runtime tool allowlists, disabled bundled plugin behavior, and worktree `delegate`/`ask`/`auto-pr` follow-through under OpenClaw `2026.5.28`.

## [4.3.3] - 2026-05-27

### Fixed
- Fixed merged worktree session listings so completed worktree outcomes render the resolved lifecycle state and summary consistently.
- Restored Telegram-native action button styling safely by omitting unsupported generic style fields while preserving callback payloads.
- Avoided duplicate fallback notifications after worktree merge or PR outcomes when routed orchestrator wake delivery is already available.
- Improved `agent_pr` pull request descriptions so generated PR bodies include clearer change summaries, validation metadata, and repository/worktree context without false-positive framework labels.

### Changed
- Updated the local OpenClaw package target to `openclaw@2026.5.26` while keeping the peer floor at `>=2026.4.21`.
- Documented the `2026.5.26` compatibility verdict: no plugin source migration was required because `openclaw-code-agent` still imports only `openclaw/plugin-sdk/plugin-entry`, declares its tool surface through `contracts.tools`, and owns its own session store, wake routing, callbacks, worktree flows, and harness model restrictions.
- Refreshed operator guidance for Telegram topic routing, Start Plan and approval callbacks, cron-origin wake delivery, Codex/Claude harness policy boundaries, runtime tool allowlists, disabled bundled plugin behavior, and worktree `delegate`/`ask`/`auto-pr` follow-through under OpenClaw `2026.5.26`.
- Refreshed dependency metadata by updating the transitive Anthropic SDK lockfile resolution and removing stale pnpm build allowlist entries no longer needed by the current OpenClaw target.

## [4.3.2] - 2026-05-26

### Fixed
- Fixed Telegram worktree decision prompts by stripping generic button `style` fields from Telegram-native callback buttons before dispatch.

## [4.3.1] - 2026-05-25

### Fixed
- Fixed Telegram callback button payload handling so OpenClaw cross-channel callback data is preserved before interactive plan, Start Plan, and worktree decision actions reach the plugin.

### Changed
- Updated the local OpenClaw package target to `openclaw@2026.5.22` while keeping the peer floor at `>=2026.4.21`.
- Documented the `2026.5.22` compatibility verdict: no plugin source migration was required for the new channel-message poll, row-level session workflow, generic harness task completion, embedding/source-provider, cron delivery, or Codex app-server SDK surfaces because `openclaw-code-agent` still imports only `openclaw/plugin-sdk/plugin-entry` and owns its own session store.
- Refreshed operator guidance for Telegram topic routing, Start Plan and approval callbacks, completion wakes, worktree `delegate`/`ask`/`auto-pr` follow-through, runtime tool visibility, disabled bundled plugin boundaries, and Codex/Claude harness model restrictions under OpenClaw `2026.5.22`.

## [4.3.0] - 2026-05-20

### Added
- Added Codex `harnesses.codex.fastMode` configuration so Codex App Server thread, resume, and turn payloads can opt into `service_tier: "fast"` for new and continued Codex sessions.
- Added orchestrator-owned follow-up summary wakes after merge and PR worktree terminal outcomes, including route preservation back to the originating chat/thread.

### Changed
- Kept Codex reasoning effort on the current App Server `reasoningEffort` field across fresh thread, resume, and turn-start payloads, including plan-mode collaboration settings.
- Updated the local OpenClaw package target to `openclaw@2026.5.18` while keeping the peer floor at `>=2026.4.21`.
- Documented the `2026.5.18` compatibility verdict: no plugin compatibility code update was needed because the plugin SDK `plugin-entry` type surface was unchanged from `2026.5.12`, the manifest already uses `contracts.tools`, and this plugin only imports `openclaw/plugin-sdk/plugin-entry` from the OpenClaw SDK.
- Clarified that merge/PR tools first deliver the canonical plugin status line, then wake the orchestrator to read the full output and send one short factual routed summary.

## [4.2.4] - 2026-05-14

### Changed
- Updated the local OpenClaw package target to `openclaw@2026.5.12` while keeping the peer floor at `>=2026.4.21`.
- Refreshed OpenClaw `2026.5.12` compatibility guidance around the current TaskFlow runtime surface, final/main Codex app-server churn, and plugin install/runtime scanning.

## [4.2.3] - 2026-05-07

### Changed
- Updated the local OpenClaw package target to `openclaw@2026.5.7` while keeping the peer floor at `>=2026.4.21`.
- Refreshed OpenClaw `2026.5.7` compatibility guidance around plugin allowlists, bundled discovery, managed npm override inheritance, and Codex provider/runtime routing.

## [4.2.2] - 2026-05-06

### Fixed
- Fixed Codex `ask` and `delegate` worktree launches so fresh sessions start in the prepared plugin-managed worktree instead of the original checkout.
- Preserved worktree strategy, base branch, and PR target when auto-resuming sessions.
- Resumed missing Codex backend worktree refs conservatively without treating native restore metadata as fresh backend-managed execution.
- Added the default managed `.worktrees/` directory to the repo-local git exclude file when creating worktrees.

### Docs
- Replaced the README GIFs with static screenshots for direct completion, plan review, `ask` worktree decisions, and delegated worktree follow-through.
- Refreshed Codex worktree docs to distinguish plugin-managed fresh worktrees from native backend restore refs.

## [4.2.1] - 2026-05-06

### Changed
- Updated the local OpenClaw package target to `openclaw@2026.5.6` while keeping the peer floor at `>=2026.4.21`.
- Refreshed OpenClaw `2026.5.6` compatibility guidance around Codex route warnings, plugin-owned harness model restrictions, and adjacent bundled plugin boundaries.

## [4.2.0] - 2026-05-06

### Changed
- Extracted keyed async operation queueing from `SessionManager` and reused it for per-repository merge serialization.
- Reused the keyed operation queue for ordered wake dispatch and moved session maintenance scheduling into an internal service.
- Centralized chat command argument tokenization so `/agent`, `/agent_respond`, `/agent_output`, and `/agent_goal` share quoted-argument handling.
- Reworked README goal-task examples to use human conversation prompts instead of command invocations.
- Updated the release workflow to publish the same packed artifact to npm and ClawHub.
- Reworked the README into a shorter operator-first guide and moved release-detail emphasis back to the changelog/reference docs.
- Aligned worktree decision button documentation with the current state-aware `Merge`, `Open PR`, `View PR`, `Sync PR`, `Later`, and `Discard` labels.
- Removed the stale `workflows/` package file entry because no workflows are shipped in the npm tarball.
- Reframed README examples around human chat workflows while keeping tools documented as the agent-facing API surface.
- Routed `/agent` through the shared launch resolver used by `agent_launch`, so chat commands and tool launches share workdir, model, routing, and resume-first behavior.
- Deduplicated goal launch validation and output formatting across `/agent_goal` and `agent_goal_launch`.
- Extracted shared plan-approval delivery guards/text builders and session output-preview selection from `SessionManager`.
- Updated the local OpenClaw package target to `openclaw@2026.5.5` while keeping the peer floor at `>=2026.4.21`.
- Added the generic `agent_send_plan_offer` helper for external workflows that need Start Plan / Dismiss buttons without a monitor-specific API.
- Removed the legacy monitor plan-offer tool aliases and compatibility callback path in favor of the generic plan-offer action tokens.
- Refreshed `@anthropic-ai/claude-agent-sdk` and `nanoid` dependency resolutions.

### Fixed
- Reused the shared model allowlist helper in agent launch resolution and cleaned up patch-era comments in launch, merge, session, and startup cleanup code.
- Corrected architecture docs for the plugin entry surface.
- Updated plugin manifest worktree-strategy help text to remove stale `Merge locally` / `Create PR` button names.

## [4.1.2] - 2026-05-06

### Fixed
- Fixed Telegram plan approval prompts so the canonical Approve / Revise / Reject buttons are delivered through the shared direct-message presentation path.
- Added explicit plain-text Approve / Revise / Reject handling while a plan is awaiting review, so sessions remain controllable when interactive buttons cannot be delivered.
- Stopped stale Plan v2 approval prompts from resurfacing after a plan is rejected or the session is killed.

### Docs
- Refreshed README, operator reference, architecture, ACP comparison, development, contributor, and orchestration-skill docs around plan approval, Telegram buttons, text fallback behavior, diagnostics, and release-prep validation. The worktree-default note is a documentation correction: prior skill docs incorrectly described `defaultWorktreeStrategy` as defaulting to `off`; no runtime behavior changed, and the actual default remains `delegate`.
- Documented the release smoke evidence from the Builds & Tools topic: `rust-hello-world-minor-change-2` (`FzPCkqjh`) completed as `approved_then_implemented` after explicit approval, and a later run (`VmUBWOH2`) delivered a clean plan prompt without the old stale Plan v2-after-reject behavior.

## [4.1.1] - 2026-05-05

### Changed
- Updated the local OpenClaw build/test target to stable `2026.5.4` while keeping the minimum compatibility floor at `>=2026.4.21`.
- Aligned harness reasoning-effort handling with OpenClaw `v2026.5.4`: Claude Code now receives configured non-default effort, and Codex fresh thread starts include effort alongside resume and turn-start payloads.
- Added compatibility coverage for v2026.5.4 manifest contracts, model allowlists, disabled bundled-provider assumptions, callback delivery, and bounded monitor launch routing.

## [4.1.0] - 2026-05-01

### Added

- Wired code-agent sessions into OpenClaw's managed TaskFlow lifecycle when the current SDK runtime exposes the required managed-flow surface, with a no-op fallback for older runtimes.
- Added session TaskFlow lifecycle coverage for creation, progress, waiting states, terminal success/failure, revision-conflict handling, and runtimes without the managed-flow API.

### Changed

- Updated the local OpenClaw build/test target to stable `2026.4.29` while keeping the minimum compatibility floor at `>=2026.4.21`.
- Declared explicit startup activation so OpenClaw continues loading the plugin's background services and interactive handlers as startup activation becomes stricter.
- Let monitor-report Start Plan actions carry an explicit worktree strategy so release-follow-up jobs can run in managed branches and auto-open PRs instead of editing local `main`.
- Added compatibility guard coverage for OpenClaw `v2026.4.26`'s deprecated direct config load/write helper surface; plugin code should continue using injected runtime config and plugin-owned state instead of OpenClaw config mutation helpers.
- Refreshed the Claude Code SDK dependency through the current pnpm lockfile resolution.

### Fixed

- Fixed direct notification delivery and fallback handling so runtime-channel notification failures and timeouts are reported deterministically instead of hanging.
- Fixed canonical notification runtime-state handling so completion and no-change paths expose deterministic state rather than relying on transcript inference.
- Improved completion notification delivery diagnostics for direct user-notification paths.

## [4.0.1] - 2026-04-27

### Changed

- Updated the local OpenClaw build/test target to stable `2026.4.25` while keeping the minimum compatibility floor at `>=2026.4.21`.
- Added compatibility guard coverage for OpenClaw `v2026.4.25`'s persisted plugin install registry; plugin code must not read or write legacy authored install metadata.
- Added compatibility guard coverage for OpenClaw `v2026.4.24`'s removed embedded-extension factory path; future tool-result rewriting must use OpenClaw's runtime-neutral middleware contract when available for this plugin.

## [4.0.0] - 2026-04-24

### Breaking Changes

- Raised the minimum supported OpenClaw plugin/gateway contract from `>=2026.4.14` to `>=2026.4.21`.
- Removed the legacy Telegram `--buttons` fallback; interactive direct notifications now require the shared `message.send --presentation` contract.
- Removed the custom Discord component sender path; Discord interactive notifications now use the same shared direct presentation contract as Telegram.
- Migrated persisted approval-prompt transport metadata from `direct-telegram` to `direct-message`; older persisted sessions are normalized on restore.
- Refreshed the built-in model defaults to `anthropic/claude-sonnet-4-7` for Claude Code and `gpt-5.5` / `gpt-5.5-pro` for Codex.

### Changed

- Unified outbound interactive delivery across Telegram and Discord on one shared `message.send --presentation` path.
- Moved interactive button style selection into the shared session-interaction layer instead of transport-specific label inference.
- Added structured dispatch diagnostics for direct interactive delivery, including route, thread, button labels, and callback payload length metadata.
- Updated the local OpenClaw build/test target to stable `2026.4.23` while keeping the minimum compatibility floor at `>=2026.4.21`.

### Fixed

- Fixed Telegram approval delivery compatibility for routes that need the shared direct-message presentation contract.
- Preserved Discord callback cleanup behavior after moving outbound buttons away from the plugin-owned component sender path.

### Docs

- Updated README, reference, architecture, ACP comparison, and package/plugin metadata for the `4.0.0` breaking transport contract and `v2026.4.21` compatibility floor.

## [3.2.1] - 2026-04-22

### Changed

- Raised the external OpenClaw compatibility baseline to `v2026.4.14`.
- Prefer the `deliveryContext` / `requesterSenderId` tool-context surface introduced in newer OpenClaw releases while keeping legacy routing fallbacks for older fixtures and persisted state.
- Allowed `gpt-5.4-pro` in the built-in Codex model allowlist.
- Verified stable `v2026.4.21` compatibility and updated the local OpenClaw build/test target to `2026.4.21` without raising the minimum required gateway baseline.
- Added explicit compatibility coverage for auth-required chat commands and the Telegram topic `13832` monitor-report route used in release smoke checks.

### Fixed

- Cleared `BASH_ENV` / `ENV` from goal-task verifier subprocesses so shell startup hooks cannot silently rewrite verifier execution.
- Improved waiting-for-input notifications so forwarded question prompts carry cleaner recent context without echoing the same question text back at the user.
- Allowed worktree recreation to clean one stale blocked path when resuming against an existing branch before escalating to a hard failure.

### Security

- Added explicit plugin security checks plus dependency-review and security-audit workflow coverage.
- Refreshed vulnerable transitive dependency overrides and documented the current scanner findings and verifier-shell boundary.

## [3.2.0] - 2026-04-10

### Added

- One-attempt autonomous conflict resolution for `auto-merge`, followed by an automatic merge retry when the resolver succeeds.
- Lifecycle-first worktree resolution that can promote landed-but-not-topology-merged branches to `released` for safe cleanup and clearer status reporting.
- Shared release metadata validation so `package.json`, `openclaw.plugin.json`, and the intended release version are checked together before publish.

### Changed

- Returned ordinary successful terminal notifications to deterministic completion messaging only; the plugin no longer generates transcript-based completion summaries for users or wakes.
- Removed the remaining plugin-side no-change/report-only embedded-eval path so worktree completion messaging is fully deterministic.
- Changed the default `defaultWorktreeStrategy` back to `off`.
- Completion wakes now include explicit approval/execution context plus both requested and effective permission modes for plan-gated sessions instead of expecting the orchestrator to infer approval from transcript prose.
- Simplified worktree transition handling around shared pending-decision, conflict-resolving, and merged patch builders, and grouped live-session patch application around clearer control-state and worktree metadata boundaries.
- Standardized contributor and release validation around `pnpm verify`, removed the npm lockfile from the repo, and documented the new release metadata parity check.

### Fixed

- Normalized bare numeric Discord route targets to `channel:<id>` consistently across route/session-key handling and documentation.
- Preserved the dirty-worktree implicit-cleanup guard while removing the unshipped heuristic completion-summary behavior.
- Persisted deterministic approval/execution state so approved plan sessions now surface as `approved_then_implemented`, and plan-gate violations surface as `implemented_without_required_approval`, across terminal and no-change worktree completion paths.
- Fixed `auto-merge` so conflict handling now follows the real resolver path instead of falling through a dead code branch.
- Worktree free-space checks now probe the nearest existing ancestor of the configured base dir, so first-run and custom-dir launches validate the correct filesystem.
- Cross-repo PR auto-targeting now works when only `upstream` is configured.
- Release automation now rejects package/plugin version drift instead of validating only `package.json`.

### Docs

- Reframed the README, operator reference, and contributor docs around the concrete `3.2.0` improvements so the release story, upgrade notes, and release checklist all match the shipped behavior.

## [3.1.0] - 2026-03-28

### Breaking Changes

- Removed `multi_turn_disabled`; sessions are now multi-turn by default and no longer carry the old single-turn compatibility path.
- Changed worktree completion into an explicit pending-decision lifecycle for the newer review flows, including merge, PR, snooze, and dismiss outcomes.
- Expanded the public `worktree_strategy` surface to include `delegate`, which callers with pinned enums or schema validation must now accept.
- Persisted session storage is now new-schema-only. Older or invalid stores are archived to timestamped `.legacy-*.json` backups and are not migrated in place.

### Added

- Cross-repo PR targeting via `worktree_pr_target_repo`.
- Richer worktree decision state, including snooze / dismiss actions, PR-open tracking, and clearer merge-or-PR follow-through.
- A 4-button review flow for worktree decisions: `Merge locally`, `Create PR`, `Decide later`, and `Dismiss`.
- Bounded Codex semantic adapter for structured backend interaction.

### Changed

- Rewrote the control plane around explicit lifecycle, approval, runtime, delivery, and worktree state instead of heuristic status handling.
- Made resume behavior explicit: suspended sessions are resumable, launches are resume-first for linked sessions, and terminal sessions are no longer implicitly revived.
- Hardened notification delivery and split the wake pipeline into clearer route-resolution, delivery, and transport responsibilities.
- Stopped auto-pushing worktree branches by default; branches remain local until an explicit merge, push, or PR path chooses to publish them.
- Replaced Codex SDK with app-server backend.
- Standardized local and CI validation on `pnpm verify`.

### Fixed

- Removed plugin-side natural-language heuristics for waiting, planning, and worktree decisions in favor of explicit state and structured routing.
- Fixed worktree merge, cleanup, PR follow-through, and pending-decision handling so worktrees are preserved or cleaned up deterministically.
- Aligned Telegram and Discord interactive callbacks behind the same action-token model and tightened notification retry / shutdown behavior.
- Codex plan approval, reply forwarding, and worktree preamble behavior for plan-first sessions.
- Codex auth bootstrap so isolated homes live under OpenClaw state instead of temp paths.
- `agent_output` streaming for active sessions and conflict-resolver harness selection.
- Delegate-button routing, branch-decision messaging, and commit-misdirection reporting in worktree flows.
- Plan approval escalation, stale approval blocking, and idle-timeout button display.
- Streamed session output line buffering.
- Interactive notification fallback handling.
- Auto-resume for dead plan approvals.
- Killed-session resume behavior.
- Notification output previews now show the beginning of the output instead of the tail.

### Docs

- Rewrote the operator reference, aligned README messaging with the maintenance release, and normalized the full historical changelog.

## [3.0.0] - 2026-03-25

### Breaking Changes

- Changed the default `planApproval` mode to `ask` so plans are forwarded to the user unless the operator explicitly chooses otherwise.
- Changed the default `defaultWorktreeStrategy` to `ask`, making worktree isolation the default launch behavior at that stage of the project.
- Removed the earlier dismiss button from the `ask` worktree-decision UI at that point in history. Later releases replaced this with the broader explicit decision lifecycle.

### Changed

- Switched `agent_merge(strategy: "merge")` to a rebase-then-fast-forward flow, keeping merged history linear without merge commits.

## [2.4.0] - 2026-03-25

### Breaking Changes

- Removed `acceptEdits` permission mode. Use `default` for interactive sessions or `bypassPermissions` for fully autonomous execution.
- Replaced the old `worktree` boolean on `agent_launch` with `worktree_strategy`.
- Renamed `auto_cleanup` to `delete_branch` in `agent_merge`.
- Renamed `force` to `skip_session_check` in `agent_worktree_cleanup` while keeping `force` as a deprecated alias.

### Added

- Full git-worktree isolation with `off`, `manual`, `ask`, `delegate`, `auto-merge`, and `auto-pr` strategies.
- Worktree tools: `agent_merge`, `agent_pr`, `agent_worktree_status`, and `agent_worktree_cleanup`.
- PR lifecycle handling that can create, update, and inspect existing GitHub PRs instead of blindly opening duplicates.
- Resume-aware worktree context so branch, strategy, and PR metadata survive follow-up work.
- Daily stale-branch reminders, startup cleanup of abandoned worktrees, and stronger worktree creation safeguards.
- Telegram inline button callbacks for worktree decisions and Claude Code `AskUserQuestion` interception for plan/worktree approval flows.
- Better failure/wake notifications, per-session retry timers, larger output buffering, incremental output files, and CI/publishing workflows.

### Changed

- Defaulted `planApproval` to `ask` and `defaultWorktreeStrategy` to `ask` for safer out-of-box orchestration at that stage of the project.
- Switched base-branch detection to automatic detection instead of assuming `main`.
- Persisted the original repo `workdir` instead of the temporary worktree path so resume flows keep the correct repo context.
- Simplified `isGitRepo()` so it no longer depends on a configured remote.

### Fixed

- Button payload compatibility with the OpenClaw CLI callback shape.
- PR fallback behavior when the worktree directory is gone.
- Plan approval routing and permission-mode transitions across `ask`, `delegate`, and `approve`.
- Notification deduplication, turn-done debounce, startup recovery, worktree path races, branch collisions, lost worktree context, duplicate PR creation, and merge serialization.

## [2.3.1] - 2026-03-23

### Added

- Initial git-worktree support for isolated session branches.
- Opt-in worktree creation through `agent_launch(worktree: true)`.
- Discord wake notifications.

### Changed

- Kept worktree creation opt-in by default at this stage of the project.

### Fixed

- Worktree path collisions by adding random suffixes.
- SDK path resolution issues in early worktree-enabled launches.

## [2.3.0] - 2026-03-22

### Added

- Redirect support for active sessions via `agent_respond(interrupt: true)`.
- Turn-end wake signaling for completed turns.

### Changed

- Refined notification lifecycle wording and delivery behavior.

## [2.2.0] - 2026-02-XX

### Added

- Broad auto-resume for killed sessions through `agent_respond` except `startup-timeout`. Later releases replaced this with the explicit suspended-session resume model.
- Harness-scoped model defaults and allowlists.
- The Codex streaming harness based on the thread API.

### Fixed

- Codex resume startup confirmation.
- Codex `auth.json` race conditions through isolated per-session home handling.

## [2.1.0] - 2026-02-XX

### Added

- Multi-agent support with workspace-based channel routing.
- Plan approval modes: `ask`, `delegate`, and `approve`.

### Changed

- Default Codex approval policy to `on-request`.
- Raised the default session limit.

[Unreleased]: https://github.com/goldmar/openclaw-code-agent/compare/v4.7.20...HEAD
[4.7.20]: https://github.com/goldmar/openclaw-code-agent/compare/v4.7.19...v4.7.20
[4.7.19]: https://github.com/goldmar/openclaw-code-agent/compare/v4.7.18...v4.7.19
[4.7.18]: https://github.com/goldmar/openclaw-code-agent/compare/v4.7.17...v4.7.18
[4.7.17]: https://github.com/goldmar/openclaw-code-agent/compare/v4.7.16...v4.7.17
[4.7.16]: https://github.com/goldmar/openclaw-code-agent/compare/v4.7.15...v4.7.16
[4.7.15]: https://github.com/goldmar/openclaw-code-agent/compare/v4.7.14...v4.7.15
[4.7.14]: https://github.com/goldmar/openclaw-code-agent/compare/v4.7.13...v4.7.14
[4.7.13]: https://github.com/goldmar/openclaw-code-agent/compare/v4.7.12...v4.7.13
[4.7.12]: https://github.com/goldmar/openclaw-code-agent/compare/v4.7.11...v4.7.12
[4.7.11]: https://github.com/goldmar/openclaw-code-agent/compare/v4.7.10...v4.7.11
[4.7.8]: https://github.com/goldmar/openclaw-code-agent/compare/v4.7.7...v4.7.8
[4.7.7]: https://github.com/goldmar/openclaw-code-agent/compare/v4.7.6...v4.7.7
[4.7.6]: https://github.com/goldmar/openclaw-code-agent/compare/v4.7.5...v4.7.6
[4.7.5]: https://github.com/goldmar/openclaw-code-agent/compare/v4.7.4...v4.7.5
[4.7.4]: https://github.com/goldmar/openclaw-code-agent/compare/v4.7.3...v4.7.4
[4.7.3]: https://github.com/goldmar/openclaw-code-agent/compare/v4.7.2...v4.7.3
[4.7.2]: https://github.com/goldmar/openclaw-code-agent/compare/v4.7.1...v4.7.2
[4.7.1]: https://github.com/goldmar/openclaw-code-agent/compare/v4.7.0...v4.7.1
[4.7.0]: https://github.com/goldmar/openclaw-code-agent/compare/v4.6.0...v4.7.0
[4.6.0]: https://github.com/goldmar/openclaw-code-agent/compare/v4.5.9...v4.6.0
[4.5.9]: https://github.com/goldmar/openclaw-code-agent/compare/v4.5.8...v4.5.9
[4.5.8]: https://github.com/goldmar/openclaw-code-agent/compare/v4.5.7...v4.5.8
[4.5.7]: https://github.com/goldmar/openclaw-code-agent/compare/v4.5.6...v4.5.7
[4.5.6]: https://github.com/goldmar/openclaw-code-agent/compare/v4.5.5...v4.5.6
[4.5.5]: https://github.com/goldmar/openclaw-code-agent/compare/v4.5.4...v4.5.5
[4.5.4]: https://github.com/goldmar/openclaw-code-agent/compare/v4.5.3...v4.5.4
[4.5.3]: https://github.com/goldmar/openclaw-code-agent/compare/v4.5.2...v4.5.3
[4.5.2]: https://github.com/goldmar/openclaw-code-agent/compare/v4.5.1...v4.5.2
[4.5.1]: https://github.com/goldmar/openclaw-code-agent/compare/v4.5.0...v4.5.1
[4.5.0]: https://github.com/goldmar/openclaw-code-agent/compare/v4.4.2...v4.5.0
[4.4.2]: https://github.com/goldmar/openclaw-code-agent/compare/v4.4.1...v4.4.2
[4.4.1]: https://github.com/goldmar/openclaw-code-agent/compare/v4.4.0...v4.4.1
[4.4.0]: https://github.com/goldmar/openclaw-code-agent/compare/v4.3.8...v4.4.0
[4.3.8]: https://github.com/goldmar/openclaw-code-agent/compare/v4.3.7...v4.3.8
[4.3.7]: https://github.com/goldmar/openclaw-code-agent/compare/v4.3.6...v4.3.7
[4.3.6]: https://github.com/goldmar/openclaw-code-agent/compare/v4.3.5...v4.3.6
[4.3.5]: https://github.com/goldmar/openclaw-code-agent/compare/v4.3.4...v4.3.5
[4.3.4]: https://github.com/goldmar/openclaw-code-agent/compare/v4.3.3...v4.3.4
[4.3.3]: https://github.com/goldmar/openclaw-code-agent/compare/v4.3.2...v4.3.3
[4.3.2]: https://github.com/goldmar/openclaw-code-agent/compare/v4.3.1...v4.3.2
[4.3.1]: https://github.com/goldmar/openclaw-code-agent/compare/v4.3.0...v4.3.1
[4.3.0]: https://github.com/goldmar/openclaw-code-agent/compare/v4.2.4...v4.3.0
[4.2.4]: https://github.com/goldmar/openclaw-code-agent/compare/v4.2.3...v4.2.4
[4.2.3]: https://github.com/goldmar/openclaw-code-agent/compare/v4.2.2...v4.2.3
[4.2.2]: https://github.com/goldmar/openclaw-code-agent/compare/v4.2.1...v4.2.2
[4.2.1]: https://github.com/goldmar/openclaw-code-agent/compare/v4.2.0...v4.2.1
[4.2.0]: https://github.com/goldmar/openclaw-code-agent/compare/v4.1.2...v4.2.0
[4.1.2]: https://github.com/goldmar/openclaw-code-agent/compare/v4.1.1...v4.1.2
[4.1.1]: https://github.com/goldmar/openclaw-code-agent/compare/v4.1.0...v4.1.1
[4.1.0]: https://github.com/goldmar/openclaw-code-agent/compare/v4.0.1...v4.1.0
[4.0.1]: https://github.com/goldmar/openclaw-code-agent/compare/v4.0.0...v4.0.1
[4.0.0]: https://github.com/goldmar/openclaw-code-agent/compare/v3.2.1...v4.0.0
[3.2.1]: https://github.com/goldmar/openclaw-code-agent/compare/v3.2.0...v3.2.1
[3.2.0]: https://github.com/goldmar/openclaw-code-agent/compare/v3.1.0...v3.2.0
[3.1.0]: https://github.com/goldmar/openclaw-code-agent/compare/v3.0.0...v3.1.0
[3.0.0]: https://github.com/goldmar/openclaw-code-agent/compare/v2.4.0...v3.0.0
[2.4.0]: https://github.com/goldmar/openclaw-code-agent/compare/v2.3.1...v2.4.0
[2.3.1]: https://github.com/goldmar/openclaw-code-agent/compare/v2.3.0...v2.3.1
[2.3.0]: https://github.com/goldmar/openclaw-code-agent/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/goldmar/openclaw-code-agent/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/goldmar/openclaw-code-agent/releases/tag/v2.1.0
