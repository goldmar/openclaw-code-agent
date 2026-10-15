import "./test-env";
import { it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeHarness, startOpenCodeServer } from "../src/harness/opencode";
import { OpenCodeClient } from "../src/harness/opencode/client";
import { rulesForMode } from "../src/harness/opencode/permissions";
import type { HarnessMessage, HarnessSession } from "../src/harness/types";
async function waitFor(test: () => boolean): Promise<void> {
  const deadline = Date.now() + 20000;
  while (!test()) {
    if (Date.now() > deadline) throw new Error("native scenario timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
it(
  "runs v2 permissions, child routing, forms, steer, compact, rewind, interrupt and resume against a real server with a local provider",
  {
    skip: process.env.OPENCLAW_RUN_LIVE_OPENCODE_SMOKE !== "1",
    timeout: 90000,
  },
  async () => {
    const profile = mkdtempSync(join(tmpdir(), "oca-native-"));
    let delay = 2000;
    const provider = createServer(async (req, res) => {
      for await (const _ of req) {
      }
      const timer = setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta: unknown, finish_reason: unknown = null) => ({
          id: "chatcmpl-fixture",
          object: "chat.completion.chunk",
          created: 1,
          model: "test",
          choices: [{ index: 0, delta, finish_reason }],
        });
        for (const c of [
          chunk({ role: "assistant", content: "" }),
          chunk({ content: "OPENCODE_OK" }),
          chunk({}, "stop"),
        ])
          res.write(`data: ${JSON.stringify(c)}\n\n`);
        res.end("data: [DONE]\n\n");
      }, delay);
      res.once("close", () => clearTimeout(timer));
    });
    await new Promise<void>((resolve) =>
      provider.listen(0, "127.0.0.1", resolve),
    );
    const address = provider.address() as { port: number };
    const keys = [
      "OPENCODE_CONFIG_DIR",
      "OPENCODE_DISABLE_PROJECT_CONFIG",
      "OPENCODE_DISABLE_MODELS_FETCH",
      "OPENCODE_CONFIG_CONTENT",
    ];
    const original = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    process.env.OPENCODE_CONFIG_DIR = profile;
    process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
    process.env.OPENCODE_DISABLE_MODELS_FETCH = "1";
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      model: "oca-fixture/test",
      providers: {
        "oca-fixture": {
          package: "@opencode/ai/providers/openai-compatible",
          settings: {
            baseURL: `http://127.0.0.1:${address.port}/v1`,
            apiKey: "synthetic",
          },
          models: {
            test: {
              name: "Fixture",
              limit: { context: 10000, output: 1000 },
              capabilities: { tools: true, input: ["text"], output: ["text"] },
            },
          },
        },
      },
    });
    let handle: Awaited<ReturnType<typeof startOpenCodeServer>>;
    let active: HarnessSession | undefined;
    try {
      const h = new OpenCodeHarness({
        requestTimeoutMs: 5000,
        serverIdleShutdownMs: 60000,
        createServer: async () => (handle = await startOpenCodeServer()),
      });
      const collect = (session: HarnessSession) => {
        const events: HarnessMessage[] = [];
        const done = (async () => {
          for await (const e of session.messages) events.push(e);
        })();
        return { events, done };
      };
      let endInput!: () => void;
      const inputDone = new Promise<void>((r) => {
        endInput = r;
      });
      active = h.launch({
        prompt: (async function* () {
          yield "Reply OPENCODE_OK";
          await inputDone;
        })(),
        cwd: profile,
        model: "oca-fixture/test",
        permissionMode: "default",
      });
      const first = collect(active);
      await waitFor(() => first.events.some((e) => e.type === "run_started"));
      const ref = first.events.find((e) => e.type === "backend_ref");
      assert.equal(ref?.type, "backend_ref");
      const id = ref?.type === "backend_ref" ? ref.ref.conversationId : "";
      const client = new OpenCodeClient(handle.baseUrl, handle.authorization);
      const p = { sessionID: id };
    const planSession=await client.data("POST /api/session",{}, {location:{directory:profile},agent:"plan",permissions:rulesForMode("plan")});
    const denied=await client.data("POST /api/session/{sessionID}/permission",{sessionID:planSession.id},{action:"subagent",resources:["general"],agent:"plan"});
    assert.equal(denied.effect,"deny","plan mode must deny general subagent delegation");
      const permission = client.data(
        "POST /api/session/{sessionID}/permission",
        p,
        { action: "shell", resources: ["echo fixture"] },
      );
      permission.catch((): undefined => undefined);
      await waitFor(() =>
        first.events.some(
          (e) => e.type === "pending_input" && e.state.kind === "approval",
        ),
      );
      assert.equal(await active.submitPendingInputOption!(0), true);
      assert.equal((await permission).effect, "ask");
      const child = await client.data(
        "POST /api/session",
        {},
        {
          parentID: id,
          location: { directory: profile },
          permissions: rulesForMode("default"),
        },
      );
      const childPermission = client.data(
        "POST /api/session/{sessionID}/permission",
        { sessionID: child.id },
        { action: "shell", resources: ["echo child"] },
      );
      childPermission.catch((): undefined => undefined);
      const pendingCount = first.events.filter(
        (e) => e.type === "pending_input",
      ).length;
      await waitFor(
        () =>
          first.events.filter((e) => e.type === "pending_input").length >
          pendingCount,
      );
      assert.equal(await active.submitPendingInputOption!(0), true);
      assert.equal((await childPermission).effect, "ask");
      const form = await client.data("POST /api/session/{sessionID}/form", p, {
        title: "Question",
        metadata: { kind: "question" },
        fields: [
          {
            key: "q0",
            type: "string",
            title: "Pick",
            options: [{ label: "Yes", value: "Yes" }],
            custom: false,
          },
        ],
      });
      await waitFor(() =>
        first.events.some(
          (e) => e.type === "pending_input" && e.state.requestId === form.id,
        ),
      );
      assert.equal(await active.submitPendingInputOption!(0), true);
      assert.equal(await active.steer!("Keep the reply brief."), true);
      await waitFor(() => first.events.some((e) => e.type === "run_completed"));
      endInput();
      await first.done;
      const result = first.events.findLast((e) => e.type === "run_completed");
      assert.equal(
        result?.type === "run_completed" && result.data.success,
        true,
      );
      assert.equal(
        result?.type === "run_completed" && result.data.result,
        "OPENCODE_OK",
      );
      delay = 10;
      for (const launch of [
        { prompt: h.buildThreadActionMessage({ kind: "compact" }) },
        { prompt: "Resume after rewind", rewindTurns: 1 },
      ]) {
        const prompt =
          typeof launch.prompt === "string"
            ? launch.prompt
            : (async function* () {
                yield launch.prompt;
              })();
        active = h.launch({
          prompt,
          cwd: profile,
          model: "oca-fixture/test",
          resumeSessionId: id,
          rewindTurns: launch.rewindTurns,
        });
        const c = collect(active);
        await c.done;
        const result = c.events.findLast((e) => e.type === "run_completed");
        assert.equal(
          result?.type === "run_completed" && result.data.success,
          true,
          JSON.stringify(result),
        );
      }
      delay = 10000;
      active = h.launch({
        prompt: "Wait for interruption",
        cwd: profile,
        model: "oca-fixture/test",
        resumeSessionId: id,
      });
      const interrupted = collect(active);
      await waitFor(() =>
        interrupted.events.some((e) => e.type === "activity"),
      );
      await active.interrupt!();
      await interrupted.done;
      const stopped = interrupted.events.findLast(
        (e) => e.type === "run_completed",
      );
      assert.equal(
        stopped?.type === "run_completed" && stopped.data.outcome,
        "interrupted",
      );
    } finally {
      await handle?.close();
      await active?.close?.().catch((): undefined => undefined);
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      for (const key of keys) {
        if (original[key] === undefined) delete process.env[key];
        else process.env[key] = original[key];
      }
    }
  },
);
