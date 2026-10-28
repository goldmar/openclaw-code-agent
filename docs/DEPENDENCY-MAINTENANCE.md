# Weekly dependency maintenance

Dependabot owns discovery and grouping. The existing workspace dependency watch
owns admission of one weekly OCA session. That session prepares the owning PRs,
coordinates their existing checks/reviews, and performs only eligible protected
merges. Actions is a read-only observer, never a second merge executor.

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

Before merging the implementation, inspect Dependabot's pending proposals and
prove regrouping cannot close, replace, or update the held SDK migration #568.
If that cannot be established, hold the implementation merge until #568's owner
resolves it. Configuration changes can affect existing bot PRs even while the
activation variable is false. The three-day cooldown remains; pnpm's
`minimumReleaseAge` stays zero. Dependabot automatic rebasing is disabled for
new PRs; previously open PRs can continue rebasing for 30 days after creation.

Routine standing merge authority, **after activation only**, covers patch/minor
`@types/node` and `fast-check`, stable patch updates of `@hono/node-server`,
`express-rate-limit`, `fast-uri`, `hono`, `ip-address`, `qs`, and `zod`, and CodeQL-only
patch/minor action SHA changes. Every dependency in a mixed group must qualify.
CodeQL version annotations must resolve to their pinned commit through the
official upstream tag, including annotated tags.
Unchanged locked versions retain their source URL and checksum; new resolutions
must use registry tarballs and integrity metadata. No new dependency, major,
prerelease, 0.x update, provider/host/toolchain drift,
security-floor change, source change, live-acceptance requirement, or changed
workflow behavior is routine. Unknown parsing/evidence is a hold, never consent.

Exact OpenClaw baseline/dev pins, host/API/peer floors and security floors remain
owner-controlled. SDK/toolchain and release-tool groups require explicit review.
Claude Agent SDK 0.3.312 changes permission/settings behavior and is in this lane;
this policy does not authorize that bump. #568 stays draft/unmerged with no
auto-merge request. No Claude calls or quota probes. Releases remain held until
#568 merges; no publication, tag, install, runtime reload or Gateway restart is
authorized by dependency maintenance.

## Prepare once, verify once per final head

Process groups sequentially against settled main: eligible development, runtime
and CodeQL candidates first, then reviewed groups. Finish a group's merge or
record its hold before preparing the next. Do not start all suites on old bases
and then refresh every remaining PR after the first merge.

1. The weekly owner inventories all open dependency PRs before writing. Reuse
   existing owning PRs and branches. Ambiguous duplicate ownership blocks writes.
   Exclude #568 before any branch, label, review or merge operation. Disable any
   inherited auto-merge request on other owned PRs before modifying their heads.
2. Keep `dependency-preparing` set to suppress Greptile. Refresh each owned branch
   from current main only when necessary, after verifying its expected remote
   head. Do not force-push over another writer. Collect all compatible changes
   before validation; use focused checks during repair, not a suite per package.
3. Preserve manifest pin/range styles. Update matching runtime overrides, generate
   `pnpm-lock.yaml` with pinned pnpm, and run `pnpm generate:npm-shrinkwrap` when
   the production graph changes. Never hand-edit generated artifacts. Inspect
   unexpected resolutions. Run repository-required local verification once on
   the complete candidate through approved host/remote wrappers.
4. With the complete local commit SHA and freshly observed PR base SHA, create
   an **unedited**, standalone issue comment as an authenticated repository
   writer, exactly:

   ```text
   <!-- oca-dependencies-ready:v1 <40-character-head-sha> <40-character-base-sha> -->
   ```

   Add `dependency-ready` before the one final push. Retain
   `dependency-preparing` while CI runs; it suppresses review, not CI admission.
   The normal synchronize event now runs full CI on the prepared head. Do not
   add a labeled trigger to CI: that would duplicate suites on other labels.
   If the bot head needed no commit, rerun its existing held workflow runs once
   only when their original event head **and base** still equal the live PR.
   A rerun retains its original event: a fresh receipt cannot repair a stale
   event base after another group merges. In that case integrate current main
   into the owned branch and publish the complete refreshed commit through a
   fresh synchronize event first; if this cannot be done safely, hold the PR.
   Never loop reruns against an obsolete event. Do not rerun
   already successful exact-head evidence. Never manufacture check conclusions.
5. Once all required CI is green, remove `dependency-preparing`. Inspect current
   Greptile checks/comments first. Request `@greptileai` only if this head has
   neither a pending nor completed review. A later repair first restores the
   preparation label and coalesces its changes, then obtains fresh head evidence.
6. From the trusted, reviewed default-branch policy source, run:

   ```sh
   OCA_DEPENDENCY_BATCHING_ENABLED=true node scripts/dependency-maintenance.mjs --pr NUMBER
   ```

   Only `status: eligible` permits the weekly owner to proceed. It requires the
   actual allowed dependency diff, current head/base receipt, all ten required
   GitHub Actions checks successful (not skipped), other current checks green,
   latest Greptile summary at 5/5 with no blocking issues on the full head SHA,
   and no unresolved review threads or outstanding change requests. The JSON
   result is evidence, not a merge command or a durable grant.
7. Immediately recheck the live head/base, required branch protections and review
   state. Changed protection requirements are a hold until the policy is updated.
   Merge with the existing owner's GitHub authorization only:

   ```sh
   gh pr merge NUMBER --repo goldmar/openclaw-code-agent --squash --match-head-commit HEAD_SHA
   ```

   No `--admin`, force, fake approval or persistent `--auto` request. GitHub must
   enforce all protections. Verify `MERGED` and the resulting main commit. A
   replaced head is a hold, not permission to retry against its new SHA. Refresh
   remaining groups' base evidence after each merge; retain valid unchanged-head
   CI/review only when it remains applicable, and never reuse a stale receipt.

The policy command performs only GETs and a GraphQL query, never PR checkout,
installation, review writes, readiness writes or merging. Its workflow checks
out the immutable trusted workflow SHA, with credentials persistence disabled.
PR contents are data. No secrets or write token are passed to PR code.

## Greptile activation handoff

No repository Greptile configuration existed at inspection. Its dashboard
settings were not accessible in this implementation session. Before activation,
read the effective dashboard/repository settings and preserve all existing rules,
filters and exclusions. Add `dependency-preparing` to disabled labels, and prove
it suppresses automatic reviews of new bot proposals and preparation pushes.
Prove the final-head manual review path works after removing the label. Do not
add author-wide exclusions, auto-approvals, review bypasses or overwrite the
whole dashboard configuration. If the platform cannot provide this behavior,
keep activation blocked and report that concrete limitation.

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
