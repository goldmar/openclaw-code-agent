# Security

Security notes for `openclaw-code-agent`: accepted subprocess surfaces, shell boundaries, and current plugin-security scanner behavior.

## Threat Model Summary

This plugin is intentionally an orchestration layer around local developer tooling. It is expected to:

- spawn local agent backends
- run local `git` / `gh` commands for worktree and PR flows
- shell out to the local `openclaw` CLI for wake and notification delivery
- optionally run operator-provided verifier shell commands in explicit goal-task flows

Because of that design, static scanners that flag any `child_process` usage will report this plugin. That finding is expected and should be reviewed as an accepted design surface, not treated as accidental malicious behavior.

## Accepted Subprocess Surfaces

The reviewed subprocess surfaces are:

- Notification and wake delivery via the local `openclaw` CLI.
  Source: `src/wake-delivery-executor.ts`
  Rationale: delivery stays gateway-owned; the plugin does not create its own network client for lifecycle wakes.
- Codex App Server launch over stdio.
  Source: `src/harness/codex-rpc.ts`
  Rationale: this is the native Codex backend transport.
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

## Current Scanner Findings

`pnpm check-plugin-security` currently reports:

1. `Shell command execution detected (child_process)`
2. `Environment variable access combined with network send`

### `child_process`

This finding is legitimate but expected. The plugin cannot provide its core orchestration features without spawning local processes.

### `Environment variable access combined with network send`

This finding is only partially informative.

The source tree does read environment variables for normal local configuration, for example:

- Codex command overrides
- worktree directory overrides
- persisted-path resolution

The source tree also sends lifecycle notifications and wakes.

In the shipped bundle, those otherwise unrelated behaviors live in the same `dist/index.js`, so the scanner reports them together as a possible credential-harvesting pattern. In the reviewed source paths, the notification and wake code does not read sensitive env values and forward them into outbound payloads. Treat this finding as a bundled-file heuristic unless a source-level review shows a concrete exfiltration path.

## Review Guidance

When reviewing future scanner output for this plugin:

- expect `child_process` findings and verify they still map only to the accepted surfaces above
- scrutinize any new env-to-network path that reads secrets and serializes them into outbound messages or external subprocess arguments
- treat new shell usage outside the accepted surfaces as suspicious until justified
- keep tests around Discord delivery, wake delivery, and goal verifiers green after any refactor touching transport or subprocess code
