# Weekly dependency maintenance

Dependabot owns discovery and grouping. The existing workspace dependency watch
owns admission of one weekly OCA session. That session combines the routine
proposals into one PR, gets one review of it, performs only an eligible protected
merge, and closes the originals. Actions is a read-only observer, never a second
merge executor.

This repository supplies the policy and CI preparation gate. The parent
workspace integration below is required separately. Merging this implementation
alone does not activate the gate or grant standing merge authority.

## Activation and standing authority

The repository variable `OCA_DEPENDENCY_BATCHING_ENABLED` must be exactly `true`
to activate preparation gating and produce an eligible policy result. Missing or
false leaves ordinary CI behavior in place and reports `activation-required`.
Do not set it during implementation PR delivery. Activation is a separate owner
operation after the parent integration and Greptile settings are reviewed and
verified. Disable the variable to restore ordinary CI admission; pause the
existing parent admission job to stop automated preparation/merges. Never cancel
an admitted owner without reconciling its state.

The three-day cooldown remains; pnpm's `minimumReleaseAge` stays zero. Dependabot
automatic rebasing is disabled for new PRs.

Routine standing merge authority, **after activation only**, covers patch/minor
`@types/node` and `fast-check`, stable patch updates of `@hono/node-server`,
`express-rate-limit`, `fast-uri`, `hono`, `ip-address`, `qs`, and `zod`, and CodeQL-only
patch/minor action SHA changes. Every dependency in a combined PR must qualify.
CodeQL version annotations must resolve to their pinned commit through the
official upstream tag, including annotated tags.
Unchanged locked versions retain their source URL and checksum; new resolutions
must use registry tarballs and integrity metadata. No new dependency, major,
prerelease, 0.x update, provider/host/toolchain drift,
security-floor change, source change, live-acceptance requirement, or changed
workflow behavior is routine. Unknown parsing/evidence is a hold, never consent.

Exact OpenClaw baseline/dev pins, host/API/peer floors and security floors remain
owner-controlled. SDK/toolchain and release-tool groups require explicit review.
Claude Agent SDK updates stay in this lane. The 0.3.312 permission/settings
boundary (auto-mode settings; `resolveSettings()` skips user or project files
with invalid auto-mode keys) was reviewed with 0.3.319 in #590: OCA passes no
`settingSources` or settings and never calls `resolveSettings()`, so the CLI
still resolves settings and OCA's permission modes are unchanged.
`tests/claude-harness.test.ts` pins that contract. A later SDK bump needs its
own review of changelog entries since the reviewed version; this policy never
authorizes one. Claude is authorized only for the independent review fallback below; no quota probes. No
publication, tag, install, runtime reload or Gateway restart is authorized by
dependency maintenance.

## One combined PR, one review

Each week's routine proposals become one PR, so they share one Greptile review.

1. The weekly owner inventories all open dependency PRs before writing. Ambiguous
   duplicate ownership blocks writes. Sort them: a proposal is routine only if all
   of its updates qualify above. Any other proposal stays open and untouched, and
   is reported as held for an owner decision.
2. From current main, create `dependencies/combined-YYYY-MM-DD`, using the batch's
   Monday date. Apply every routine update there, once: preserve manifest pin/range
   styles, update matching runtime overrides, generate `pnpm-lock.yaml` with pinned
   pnpm, and run `pnpm generate:npm-shrinkwrap` when the production graph changes.
   Never hand-edit generated artifacts. Inspect unexpected resolutions.
3. Open one PR only when the branch is complete, labelled `dependency-combined`,
   with the superseded PR numbers in its body. Greptile reviews a repository
   writer's PR when it opens, and CI runs normally. No readiness receipt applies.
4. Inspect current Greptile checks/comments first. Request `@greptileai` only if
   this head has neither a pending nor completed review, which normally means only
   after a repair push. Coalesce repairs; the allowance is one Greptile review per PR.
   A prior-head review spends it. When exhausted, use the independent Claude fallback below
   instead of waiting for or requesting another Greptile review. If no compatible routine update remains after a
   repair, hold the batch and leave the originals open.
5. From the trusted, reviewed default-branch policy source, run:

   ```sh
   OCA_DEPENDENCY_BATCHING_ENABLED=true node scripts/dependency-maintenance.mjs --pr NUMBER
   ```

   Only `status: eligible` permits the weekly owner to proceed. It requires a
   repository writer as author, the actual allowed dependency diff, all ten required
   GitHub Actions checks successful (not skipped), other current checks green,
   either Greptile's own successful check and 5/5 summary on the full head SHA
   within its review allowance, or a valid independent Claude review when that
   allowance is exhausted,
   and no unresolved review threads or outstanding change requests. The JSON
   result is evidence, not a merge command or a durable grant.
6. Immediately recheck the live head/base, required branch protections and review
   state. Changed protection requirements are a hold until the policy is updated.
   Merge with the existing owner's GitHub authorization only:

   ```sh
   gh pr merge NUMBER --repo goldmar/openclaw-code-agent --squash --match-head-commit HEAD_SHA
   ```

   No `--admin`, force, fake approval or persistent `--auto` request. GitHub must
   enforce all protections. Verify `MERGED` and the resulting main commit. A
   replaced head is a hold, not permission to retry against its new SHA.
7. Only after that merge, close each superseded PR with a short comment linking the
   combined PR. Use a plain close, never an `@dependabot ignore` command, which would
   block later updates. Main now holds those versions, so Dependabot has nothing to
   propose until a newer release, which arrives as a normal new proposal.

### Proposals outside the combined PR

Actions and other non-npm proposals that qualify keep their own PR. While activation
is on, CI holds a Dependabot PR until it has a receipt. An owner who takes such a PR
runs its generators, then posts an **unedited**, standalone comment as an
authenticated repository writer, exactly:

```text
<!-- oca-dependencies-ready:v1 <40-character-head-sha> <40-character-base-sha> -->
```

Add `dependency-ready` before the one final push, keep `dependency-preparing` until CI
is green, then remove it and apply steps 4 to 6. If the head needed no commit, rerun
its held workflow runs once, only when their original event head **and base** still
equal the live PR. Never loop reruns against an obsolete event or manufacture check
conclusions.

The policy command performs only GETs and a GraphQL query, never PR checkout,
installation, review writes, readiness writes or merging. Its workflow checks
out the immutable trusted workflow SHA, with credentials persistence disabled.
PR contents are data. No secrets or write token are passed to PR code.

## Independent Claude fallback (owner decision 2026-11-10)

Keep Greptile whenever its budget is available. A spent prior-head review,
multiple authentic Greptile review attempts, or an authentic Greptile bot notice
that the review limit is reached/budget exhausted permits an additional independent
Claude review. A timeout, missing evidence or someone else's quota claim does not.
Run this command from trusted default-branch policy source, never PR source:

```sh
node scripts/dependency-claude-review.mjs --pr NUMBER --post
```

It reads the complete immutable base/head contents for every changed dependency
or action file, then calls the existing host `claude` CLI with model
`claude-opus-5-5`, no tools, MCP servers or model fallback. It runs in a fresh
empty temporary directory under `--safe-mode --restricted`, with auto memory,
CLAUDE.md and attachment loading explicitly disabled. Init must attest that cwd,
no memory paths, extra directories, skills or loadable plugins. The CLI's own
immutable builtin plugin metadata is permitted, matching the existing host CLI contract. The v2 receipt requires
`isolation: empty-cwd-safe-mode-v1`; earlier v1 receipts grant no fallback.
See the official [CLI reference](https://code.claude.com/docs/en/cli-reference)
and [environment reference](https://code.claude.com/docs/en/env-vars). Fable is never allowed.
The CLI's init, assistant model and usage must attest Opus 5.5, and a successful
structured result must report no findings for that exact head/base. Findings,
quota failure, missing/truncated input or a changed PR fail closed. No separate
quota probe is made. Dependency scope, required CI, genuine current-head Greptile objections or pending reviews, unresolved threads, change
requests, branch protection and exact-head merge gates all remain enforced.

Only the authenticated repository owner's unedited standalone
`oca-dependency-claude-review:v2` comment is accepted as the CLI attestation.
It records reviewer, model, transport, CLI version, head/base, verdict and reason.
This is an owner attestation, not a claim that GitHub independently attests model
execution. The trusted helper produces it only after validating the real CLI
response. Never hand-write/copy a receipt. Any push or base change invalidates it.
The policy result records `reviewer` (`greptile` or `claude`) and the Claude model;
the workspace rechecks that evidence independently at completion. If neither
reviewer supplies valid evidence, hold without merging. No install/reload/restart
or broader Claude usage is authorized.

## Greptile behaviour

The review budget depends on two behaviours, which the parent proves from GitHub
evidence at each weekly admission: Dependabot proposals labelled
`dependency-preparing` get no review unless someone requests one, and a combined PR
gets a final-head review. An unrequested review on a Dependabot proposal is a hold.
Do not add author-wide exclusions, auto-approvals or review bypasses, or overwrite
dashboard configuration.

## Parent workspace handoff (separate owner, no edits here)

Patch the existing definitions through supported OpenClaw scheduler controls;
never create a second job, system cron entry, or hand-edit the scheduler DB.
Read back and preserve all unspecified fields, routing and enabled/disabled state.
The owning implementation belongs in the parent workspace, not this repository.

| Existing owner | Exact proposed change |
| --- | --- |
| `plugin-dependency-watch`, job `084e4bd3-ed6b-45a9-abb5-0baad4a1d4ca` | Change `35 9 * * *` to `35 11 * * 1`, timezone `America/Los_Angeles`; keep command wrapper and disabled scheduler delivery. |
| `openclaw_monitor/deterministic.py::run_plugin_dependencies` | Replace per-version notices with one weekly PR inventory/admission through supported native OCA orchestration, subject to the activated policy. |
| `plugin-security-watch`, job `d73d93ce-4f55-48b5-8bc6-112c63449f13` | Change `45 9 * * *` to `45 * * * *`, same timezone and command wrapper; critical/known-exploited triage on detection (up to one hour), with native GitHub alerts still immediate. |
| `openclaw_monitor/deterministic.py::run_plugin_security` | Deduplicate advisory state; immediately triage critical or evidenced known-exploited alerts; route other alerts into the weekly batch. Unknown severity/exploitability is an owner-triage hold. |
| `openclaw_monitor/deterministic.py::run_goldmar_prs` | Suppress only routine dependency notices for this repository already owned by the batch; preserve unrelated PR events. |

Keep the native Dependabot security update/alert settings enabled. Weekly version
schedules and cooldowns do not defer native security proposals. Critical or
known-exploited alerts may create an out-of-cycle protected fix batch; high-risk
changes, major/0.x behavior shifts, floor changes and live acceptance still need
an owner decision. Never infer exploitation solely from an EPSS/CVSS score.

The parent implementation must persist one owner/admission receipt per Pacific
calendar week before dispatch, with a nonblocking lock and exact PR/head inventory.
No changes means no model launch, review, push or message. Late bot proposals
wait for the next weekly admission. Resume the saved OCA session instead of
launching a duplicate; uncertain admission/delivery never expires into blind
retry. The owner may continue its admitted batch and send one completion digest
with merged/held/failed results. Deduplicate urgent exceptions by advisory and
fixed candidate, coalesce concurrent alerts, and attach a fix to an existing owner
when appropriate. Preserve prior receipts and acknowledge notifications only
after confirmed delivery. The inspected watch jobs had no job-level failure-alert
override. The parent must configure and read back native `failureAlert` with
`after: 1` and `cooldownMs: 86400000`, using the existing verified Code Agent topic
route. Intentional no-work/locked outcomes remain successful and silent. Failure
notification grants no automatic repair or additional OCA launch authority.
Registry, GitHub, authorization, inventory and dispatch-verification failures
must exit nonzero without consuming a batch. Persist uncertain dispatch before
failing; never redispatch it automatically.
Material policy/blocker transitions get one concise escalation.

Parent acceptance tests must cover week/DST boundaries, late proposals, empty
weeks, concurrent ticks, duplicate PRs/alerts, accepted/unknown dispatch, retries,
owner/session reuse, urgent critical/exploitation evidence, unknown severity,
failed delivery, execution-failure notification and one digest. Run the parent's
own required gates before requesting its separate activation. Until then these
are integration requirements, not implemented or tested workspace behavior.
