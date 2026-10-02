# Issue 504 representative host acceptance

The opt-in flow tests a packed candidate through actual OpenClaw 2026.9.7 and
Codex 0.159.3. Only ordinary Responses model text is simulated, on loopback.
It uses disposable profiles, synthetic credentials and local Git repositories.
No production Gateway, provider account, Telegram or broker is used.

Run each mode at both supported floors on the exact final reviewed commit,
through the canonical Hetzner runner with `--toolchain none --fallback none`:

```sh
sh scripts/e2e/run-oca-issue-504-host.sh \
  --expected-sha "$(git rev-parse HEAD)" --node-floor 24.16.0 --mode host
sh scripts/e2e/run-oca-issue-504-host.sh \
  --expected-sha "$(git rev-parse HEAD)" --node-floor 24.16.0 --mode gates
```

Repeat with `26.1.0`. The counted shell entry verifies fixed official Node and
pnpm artifacts and installs frozen dependencies. All paths, HOME, configuration,
cache and stores belong to that run, and PATH excludes shared `/usr/local`.
Node26 requires the runner's supported system prerequisite `libatomic.so.1`;
a missing prerequisite blocks instead of installing system packages here.
Normal shared slots are compatible when profiles, ports and toolchains remain
isolated; respect the canonical allocator's exclusive jobs and resource limits.

The host flow verifies the same tarball in a normal reference npm consumer and
the actual host installation. Publication-time manifest changes are compared
against the actual reference package, not guessed from repository JSON. Complete
dist membership/content, plugin manifest and shrinkwrap are compared. Host build
metadata identifies the published version/commit, without claiming compiled-source
attestation. The official native executable is checked before execution against
SHA256 `8bf204b36a2f6dd0dab73aa2f639892e67ef9ac8befccb4a05b1496ebf25c479`.
The fixture acknowledges its verified local archive with `--force` only after
checking its fresh bound profile has no installed extensions or plugin config
references. This acknowledges source provenance and never replaces an install.

| Behavior | Representative real host | Detailed deterministic owner |
| --- | --- | --- |
| Admission and reference failures | HTTP auth/unavailable tool; four tools with unknown/masked/blank refs, structured codes, privacy and unchanged observed effects | session-tool-diagnostics, SDK/shared contracts |
| Target selection and response/output | Older exact ID and newer name alias through native execution; allowlisted persisted target/backend/lifecycle facts | session-generation, session-reference-service, agent-respond-tool, session-advanced |
| Git policy and integration | One genuine managed worktree; PR-required refusal, fixture policy change, selected kept-tip ancestry/file/merged lifecycle, unrelated target unchanged | agent-merge-tool, agent-pr-execute, worktree-tool-context, worktree-ref-validation |
| Retry ambiguity and concurrent identities | Genuine follow-up only; no delivery guarantee | codex-harness and session-tool-diagnostics negative/retry matrix |
| Plan authority | Not exercised remotely by this flow | plan-mode-e2e, decision/approval suites |
| Embedded direct/deferred wrappers | Not exercised remotely by this flow | SDK structured-result/string-input/shared-contract tests |

The owner approved this representative mapping instead of the former exhaustive
ALL16 fixture matrix. Six queued Git schedules, same-call-ID concurrency,
rejected/lost native acknowledgements, live plan/ask and embedded direct/deferred
execution remain **unproven remotely** on the final candidate. Historical partial
receipts retain their original heads/outcomes and are not final acceptance credit.
Unchanged observed output/lifecycle/Git effects do not establish zero backend
attempts or zero Git commands. The deterministic tests own those stronger claims.

The gates mode retains frozen install plus complete verify, plugin security,
npm consumer, production audit, release metadata, bundle limit and packed dry-run.
Each host/gates invocation emits one allowlisted summary of identity, commands,
exits, test counts, outcomes, original failure and cleanup. `finalAcceptance` stays
false until the coordinator independently reviews both modes at both floors.

Owned Gateway/native descendants are recorded by PID/start time, checked before
signals, and stopped on success or failure. Unknown survivors and live listeners
block. Raw logs/config/state stay private; no transcript archaeology or debug-log
schema reconstruction is used. Failed scratch may be retained under the canonical
runner lifecycle; retained storage disposition is unproven, not secure erasure.
Auxiliary historical diagnostics block only claims dependent on those diagnostics.

External provider entitlement, production delivery, restart/multi-registry replay,
exactly-once behavior and upstream OpenClaw #120103/#155374 repair are unproven.
