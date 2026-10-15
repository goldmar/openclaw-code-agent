`completion.ndjson` was recorded on 2026-10-15 from the published Linux x64
`@opencode/cli@2.0.29` server, launched privately with `--stdio`, and driven through
the production OCA harness. A deterministic local OpenAI-compatible HTTP provider
returned `OPENCODE_OK`; no external provider or subscription was used. This is a
real OpenCode event recording with a simulated provider response.

Only session/interaction/connected events are retained. IDs and temporary profile
paths were normalized; event order, durable sequences and event payload shapes
are unchanged. In this recording execution.started precedes inbox.delivered.

The CLI's /log route returned a log.synced watermark without retained payloads
(the upstream Bus defaults to persist:false). Tests cover both replay and this
message/state recovery path. This fixture does not prove external-provider auth,
Gateway UI delivery, or permission-rule inheritance into live subagents.

Generate/check the golden mapper output with
`node --import tsx scripts/generate-opencode-replay.ts [--check]`.
