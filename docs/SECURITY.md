# Security

Security notes for `openclaw-code-agent`: accepted subprocess surfaces, shell boundaries, and current plugin-security scanner behavior.

## Threat Model Summary

This plugin is intentionally an orchestration layer around local developer tooling. It is expected to:

- spawn local agent backends
- run local `git` / `gh` commands for worktree and PR flows
- use OpenClaw-owned runtime/gateway surfaces for wake and notification delivery
- optionally run operator-provided verifier shell commands in explicit goal-task flows

Because of that design, static scanners that flag any `child_process` usage will report this plugin. That finding is expected and should be reviewed as an accepted design surface, not treated as accidental malicious behavior.

The package also declares OpenClaw install metadata in `package.json` and dangerous configuration flags in `openclaw.plugin.json` so review tools can identify it as an executable high-trust developer automation plugin rather than an instruction-only helper.

## Accepted Subprocess Surfaces

The reviewed subprocess surfaces are:

- Wake and fallback delivery via the local `openclaw` CLI.
  Source: `src/wake-delivery-executor.ts`
  Rationale: wake delivery stays gateway-owned; the plugin does not create its own network client for lifecycle wakes.
- Direct user notifications via OpenClaw runtime channel adapters.
  Sources: `src/direct-notification-transport.ts`, `src/wake-dispatcher.ts`
  Rationale: direct delivery stays inside the gateway runtime so channel account, topic/thread routing, and interactive presentation handling remain provider-owned.
- Codex App Server launch over stdio.
  Source: `src/harness/codex-rpc.ts`
  Rationale: this is the native Codex backend transport.
- OpenCode server launch on localhost.
  Source: `src/harness/opencode.ts`
  Rationale: experimental OpenCode support uses the current `opencode serve` HTTP/SSE API. The plugin binds to `127.0.0.1`, polls `/api/health`, and shuts down the child process with the session.
- Git and GitHub CLI operations for worktree lifecycle, merge, and PR flows.
  Sources: `src/worktree*.ts`, `index.ts`
  Rationale: worktree creation, merge, status, and PR handling are core product features.
- Goal-task verifier commands.
  Source: `src/goal-controller.ts`
  Rationale: verifier mode is explicitly a trusted-operator feature that runs user-supplied shell checks between iterations.

## Hardening Notes

The plugin keeps subprocess use narrow where practical:

- `openclaw`, `git`, and `gh` invocations use `execFile` / `execFileSync` argument arrays rather than shell-string interpolation.
- Discord delivery now uses explicit dependency injection in tests instead of a production env-var override for the sender module.
- Goal-task verifier execution still uses `bash -lc` by design, but now strips `BASH_ENV` and `ENV` so ambient shell bootstrap hooks cannot silently rewrite verifier execution.

Verifier commands remain powerful by design. They should be treated as trusted operator input and not exposed to untrusted users.

## Security Metadata

The release package includes:

- `openclaw.install.npmSpec`, `defaultChoice`, and `minHostVersion` in `package.json`.
- `configContracts.dangerousFlags` for `permissionMode: "bypassPermissions"`, `planApproval: "approve"`, `defaultWorktreeStrategy: "auto-merge"`, and `defaultWorktreeStrategy: "auto-pr"` in `openclaw.plugin.json`.
- Skill install metadata for the `openclaw-code-agent` npm package.

The orchestration skill should describe plugin tool state without wording that resembles prompt hierarchy changes. Local tests reject `authoritative`, `system prompt`, `developer instruction`, and `higher-priority` phrasing in `skills/code-agent-orchestration/SKILL.md`.

## Current Subprocess Review

Source review identifies one expected high-trust capability:

1. `Shell command execution detected (child_process)`

### `child_process`

This capability is legitimate but expected. The plugin cannot provide its core orchestration features without spawning local processes.

OpenClaw 2026.7.1 no longer performs built-in dangerous-code blocking during plugin installation. The release checker packs and installs the plugin under an isolated temporary home to verify the install contract without reading or migrating operator state. Operators who need a host-specific allow/block decision should configure `security.installPolicy` after reviewing the subprocess inventory below.

### Environment And Network Review

The source tree does read environment variables for normal local configuration, for example:

- Codex command overrides
- OpenCode command and localhost server auth overrides: `OPENCLAW_OPENCODE_COMMAND`, `OPENCODE_SERVER_USERNAME`, and `OPENCODE_SERVER_PASSWORD`
- worktree directory overrides
- persisted-path resolution

The source tree also sends lifecycle notifications and wakes.

In the reviewed source paths, the notification and wake code does not read sensitive env values and forward them into outbound payloads. Treat any future env-to-network scanner finding as suspicious until source review confirms whether it is only a bundled-file heuristic or a concrete exfiltration path.

## Review Guidance

When reviewing future scanner output for this plugin:

- expect `child_process` findings and verify they still map only to the accepted surfaces above
- scrutinize any new env-to-network path that reads secrets and serializes them into outbound messages or external subprocess arguments
- treat new shell usage outside the accepted surfaces as suspicious until justified
- keep tests around Discord delivery, wake delivery, and goal verifiers green after any refactor touching transport or subprocess code
