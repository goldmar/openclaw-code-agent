import "./test-env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OpenCodeHarness, startOpenCodeServer } from "../src/harness/opencode";
import { OpenCodeClient } from "../src/harness/opencode/client";
import { checkServerVersion } from "../src/harness/opencode/endpoint";
import { EventCursor } from "../src/harness/opencode/event-cursor";
import { rulesForMode } from "../src/harness/opencode/permissions";
import { sseFrames } from "../src/harness/opencode/sse";
const enabled = process.env.OPENCLAW_RUN_LIVE_OPENCODE_SMOKE === "1";
describe("OpenCode 2.0 live smoke", { skip: !enabled }, () => {
  it("validates auth, private stdio, version, session settings, durable log and fork without inference", async () => {
    const server = await startOpenCodeServer();
    try {
      const client = new OpenCodeClient(server.baseUrl, server.authorization);
      await checkServerVersion(client);
      const unauth = await fetch(server.baseUrl + "/api/info");
      assert.equal(unauth.status, 401);
      await unauth.body?.cancel();
      const info = await client.data(
        "POST /api/session",
        {},
        {
          location: { directory: "/tmp" },
          permissions: rulesForMode("plan"),
          agent: "plan",
        },
      );
      const p = { sessionID: info.id };
      assert.equal(info.location.directory, "/tmp");
      await client.request(
        "PUT /api/experimental/session/{sessionID}/instructions/entries/{key}",
        { ...p, key: "oca.system" },
        { value: "Route smoke. No inference." },
      );
      await client.request("PATCH /api/session/{sessionID}", p, {
        permissions: rulesForMode("default"),
      });
      await client.request("POST /api/session/{sessionID}/agent", p, {
        agent: "build",
      });
      await client.request("POST /api/session/{sessionID}/synthetic", p, {
        text: "Synthetic durable log probe",
        resume: false,
      });
      const frames = [];
      const cursor = new EventCursor();
      const replayed = await cursor.catchUp(client, info.id, (e) =>
        frames.push(e),
      );
      assert.ok(frames.length > 0 || (!replayed && cursor.replayUnavailable));
      const fork = await client.data(
        "POST /api/session/{sessionID}/fork",
        p,
        {},
      );
      assert.notEqual(fork.id, info.id);
      const controller = new AbortController();
      const stream = await client.raw(
        "GET",
        "/api/event",
        undefined,
        controller.signal,
        true,
      );
      for await (const frame of sseFrames(stream)) {
        assert.equal((frame.data as any).type, "server.connected");
        break;
      }
      controller.abort();
      assert.deepEqual(
        await client.data("GET /api/session/{sessionID}/permission", p),
        [],
      );
      assert.deepEqual(
        await client.data("GET /api/session/{sessionID}/form", p),
        [],
      );
    } finally {
      await server.close();
    }
  });
  it(
    "completes, steers, compacts, rewinds in place and resumes a real conversation",
    {
      skip: process.env.OPENCLAW_RUN_LIVE_OPENCODE_COMPLETION_SMOKE !== "1",
      timeout: 180000,
    },
    async () => {
      const harness = new OpenCodeHarness({ serverIdleShutdownMs: 0 });
      let conversationId: string | undefined;
      async function complete(
        prompt: unknown,
        extra: Record<string, unknown> = {},
      ) {
        const session = harness.launch({
          prompt:
            typeof prompt === "string"
              ? prompt
              : (async function* () {
                  yield prompt;
                })(),
          cwd: "/tmp",
          model: process.env.OPENCLAW_OPENCODE_SMOKE_MODEL,
          ...extra,
        });
        const messages = [];
        try {
          for await (const m of session.messages) {
            messages.push(m);
            if (m.type === "backend_ref") conversationId = m.ref.conversationId;
            if (m.type === "run_started" && typeof prompt === "string")
              await session.steer?.("Keep the reply brief.");
          }
        } finally {
          await session.close?.();
        }
        const result = messages.findLast((m) => m.type === "run_completed");
        assert.equal(result?.data.success, true, JSON.stringify(result));
        return messages;
      }
      await complete("Reply exactly OPENCODE_OK.");
      assert.ok(conversationId);
      await complete(harness.buildThreadActionMessage({ kind: "compact" }), {
        resumeSessionId: conversationId,
      });
      await complete("Reply RESUMED.", {
        resumeSessionId: conversationId,
        rewindTurns: 1,
      });
    },
  );
});
