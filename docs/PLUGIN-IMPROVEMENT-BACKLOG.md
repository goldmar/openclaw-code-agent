# Plugin Improvement Backlog

Last reviewed: 2026-04-07 (second broad pass)

This file tracks the current ranked backlog from repeated full-repo review cycles on branch `chore/plugin-improvement-loop`.

## Current ranking

No further immediately justified small/medium improvements remain after the latest broad repo scan and full `pnpm verify` pass.

1. `scripts/run-tests.mjs`: accept the common `pnpm test -- <file>` separator form.
   Justification: targeted verification currently fails on a routine invocation pattern, which slows every review cycle and produces misleading ENOENT errors.
   Status: done on 2026-04-07.

2. `src/session-route.ts`: harden weak/malformed origin-channel normalization.
   Justification: the route parser now falls back correctly for missing target segments and mixed-case weak metadata such as `"Unknown"`, avoiding notification-route loss from degraded persisted metadata.
   Status: done on 2026-04-07.

3. Session reference resolution reuse outside worktree tooling.
   Justification: worktree tools now share ref resolution helpers, but a few adjacent flows still repeat partial active/persisted lookup policy and could drift over time.
   Status: reviewed again on 2026-04-07 and parked. The remaining call sites either intentionally use direct active-first behavior or already resolve through `SessionManager` reference services; no concrete defect or bounded follow-up is justified right now.

## Latest pass conclusion

This review cycle re-scanned the repository, pressure-checked the remaining alias-resolution hotspots, and re-ran full verification.

- `pnpm verify`: pass on 2026-04-07.
- Conclusion: stop here. No additional worthwhile improvement was identified beyond the already-landed changes on this branch, so further edits would be speculative churn.
