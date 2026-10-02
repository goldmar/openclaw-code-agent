# Issue 504 isolated host acceptance

The opt-in runner exercises the exact committed candidate through pinned OpenClaw
2026.9.7 admission and execution, with a real Codex 0.159.3 native app-server.
The isolated provider keys follow the [official Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference), and native lifecycle evidence follows the [official app-server contract](https://learn.chatgpt.com/docs/app-server).
Only the Responses model provider is simulated. It uses disposable profiles,
loopback ports, synthetic credentials, and local Git repositories. It requires
both actual HTTP tool execution and subscribed embedded direct/deferred tool
execution; missing capabilities produce a blocking failure.

Run through the supported Hetzner wrapper. Jobs may share available slots when each uses its allocated workspace/cgroup, separate profiles, ephemeral ports, logs and PID cleanup, and verified private Node/pnpm installations with separate HOME/config/cache/store. Cross-floor jobs must avoid `--toolchain node`, which changes shared toolchains. Respect available slots and exclusive jobs; never bypass runner locks.

```sh
node --import tsx scripts/e2e/oca-issue-504-host-acceptance.ts \
  --expected-sha "$(git rev-parse HEAD)" \
  --codex-bin /owned-disposable-prefix/native/codex \
  --codex-version 0.159.3
```

For targeted diagnosis, add `--cohort smoke`, `plan`, `references`, `retries`,
`git`, `embedded-direct`, or `embedded-deferred`. The default `all` keeps the
complete matrix. Start with genuine setup/native smoke, then the plan cohort;
run affected cohorts after inspecting their evidence. Each invocation has its
own profile and genuine prerequisites. Summaries identify required, completed
and `not_run` scenarios and the failing stage. A selected cohort passes only its
own scope and remains `PARTIAL`, with `finalAcceptance: false`. Final acceptance
requires `all` at both supported Node floors on the same reviewed commit, plus
the full security/build/packed gates; combining partial runs does not replace it.

The fixed local R7 receipt replay is labelled `OFFLINE_SOURCE_DERIVED_REPLAY`.
It verifies the historical bundle, separate capture and parent terminal evidence.
The original failed outcome and absent normalized fields remain unchanged;
normalization of the controlled source fixture is a separate predicate check,
not evidence that the newer projector ran in that historical host.

The candidate must be committed and clean. The runner builds, packs and installs
that candidate in its disposable profile. It verifies every installed dist file
and relevant manifest. A read-only isolated Python archive reader validates bounded
gzip/tar content without extraction. Actual packed publication bytes must match
the reviewed pnpm 11 transformation, and installed bytes must equal those
observed archive members. The runner also verifies native ELF bytes before execution, initialization,
thread/turn evidence, actual host tool call IDs, provider inputs, Git effects,
and process/listener teardown. Kernel ownership uses PID and start time, so
exec or process-group changes do not count as exit. Cleanup signals only captured
processes and refuses unproven surviving group members. Package commands use
owned npm configuration/cache and the official registry. Native acquisition must also have the coordinator's
independently reviewed official npm artifact receipt. The reviewed Linux x64
native member SHA256 is
`8bf204b36a2f6dd0dab73aa2f639892e67ef9ac8befccb4a05b1496ebf25c479`.
Run both Node 24.16.0 and 26.1.0 on the same final reviewed SHA, alongside the full,
security, shared-contract, build and packed consumer gates.

Results label the two real-host lanes separately. Published host build metadata
and npm lock integrity are recorded; they do not attest the compiled host source. Utility and plugin-fixture
regressions, packed-load checks, and synthetic host-module probes cannot fulfill
these lanes. A provider thread-header mapping is reported unproven when absent;
serialized native thread/turn and fresh provider input evidence remain distinct.
Repeated call IDs report measured native start/steer and provider counts. They do
not establish durable delivery receipts or exactly-once behavior. Backend rejection
or a host result-recording failure does not justify blind replay.

This acceptance does not prove external provider entitlement, production Telegram
or broker delivery, the reporter's live host/hooks, restart or multi-registry
replay guarantees, or repair OpenClaw upstream #120103/#155374. Detailed legacy,
callback, requester-custody and ambiguous-backend controls remain explicitly
labelled plugin fixtures unless separately exercised through the actual host.

Direct embedded Responses exposes readable tool content; the host's public
after-hook separately observes native structured details. Deferred ToolSearch
exposes its contained native result and records the outer failure separately.
Bare provider call IDs and function-item IDs are retained and correlated with
the exact composite host call ID. Rejected steering, accepted steering, queued
turns, uncertain outcomes and model-provider requests have separate counts.

Success and failure retain private evidence under ignored
`.reports/issue504/host-v<Node>-<SHA>-<UUID>` (directory 0700/files 0600). The final
JSON publishes `evidence.path` and `evidence.manifestSha256`. Each stream/file is
capped at 1 MiB and the bundle at 8 MiB; diagnostic tails record truncation,
observed bytes and hashes. Mandatory proof overflow blocks acceptance. No
config, credentials, state tree or full provider transcript is copied. The
coordinator retrieves the allowlisted files and verifies their hashes through
the supported remote wrapper before remote expiration. Cleanup failures retain
owned scratch for diagnosis and always fail acceptance.
