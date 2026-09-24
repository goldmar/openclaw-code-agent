import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeHarness, startOpenCodeServer } from "../src/harness/opencode";
import type { HarnessMessage } from "../src/harness/types";

const RUN_LIVE = process.env.OPENCLAW_RUN_LIVE_OPENCODE_SMOKE === "1";
const RUN_COMPLETION = process.env.OPENCLAW_RUN_LIVE_OPENCODE_COMPLETION_SMOKE === "1";
/** Optional `provider/model` for the completion smoke (e.g. a free OpenCode Zen model). */
const SMOKE_MODEL = process.env.OPENCLAW_OPENCODE_SMOKE_MODEL?.trim() || undefined;

type LiveServer = {
  baseUrl: string;
  cwd: string;
  close(): Promise<void>;
};

/** Start the real server exactly as the harness does (`--port 0`, URL from stdout). */
async function startLiveServer(): Promise<LiveServer> {
  const cwd = await mkdtemp(join(tmpdir(), "openclaw-opencode-smoke-"));
  try {
    const handle = await startOpenCodeServer({ startupTimeoutMs: 20_000 });
    return {
      baseUrl: handle.baseUrl,
      cwd,
      async close(): Promise<void> {
        await handle.close();
        await rm(cwd, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(cwd, { recursive: true, force: true });
    throw error;
  }
}

async function requestJson<T>(
  server: LiveServer,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; contentType: string; data: T; text: string }> {
  const url = new URL(`${server.baseUrl}${path}`);
  url.searchParams.set("directory", server.cwd);
  const response = await fetch(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  assert.match(contentType, /application\/json/, `${method} ${path} returned ${response.status} ${contentType}: ${text.slice(0, 300)}`);
  return {
    status: response.status,
    contentType,
    data: JSON.parse(text) as T,
    text,
  };
}

async function requestNoContent(
  server: LiveServer,
  method: string,
  path: string,
  body?: unknown,
): Promise<void> {
  const url = new URL(`${server.baseUrl}${path}`);
  url.searchParams.set("directory", server.cwd);
  const response = await fetch(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  assert.equal(response.status, 204, `${method} ${path} returned ${response.status} ${response.headers.get("content-type")}: ${text.slice(0, 300)}`);
}

async function collectUntilCompleted(session: { messages: AsyncIterable<HarnessMessage> }): Promise<HarnessMessage[]> {
  const messages: HarnessMessage[] = [];
  const deadline = Date.now() + 45_000;
  for await (const message of session.messages) {
    messages.push(message);
    if (message.type === "run_completed") return messages;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for OpenCode live completion. Saw message types: ${messages.map((msg) => msg.type).join(", ")}`);
    }
  }
  return messages;
}

function assertOpenCodeVersion(): void {
  const command = process.env.OPENCLAW_OPENCODE_COMMAND?.trim() || "opencode";
  const version = execFileSync(command, ["--version"], { encoding: "utf8" }).trim();
  const [major, minor] = version.split(".").map((part) => Number.parseInt(part, 10));
  assert.ok(major > 1 || (major === 1 && minor >= 16), `expected opencode >= 1.16, got ${version}`);
}

describe("OpenCode live server smoke", { skip: !RUN_LIVE }, () => {
  it("validates the real classic lifecycle route contract without model inference", async () => {
    assertOpenCodeVersion();
    const server = await startLiveServer();
    try {
      // `/api/*` is OpenCode's v2 surface: the web-app HTML shell on 1.16.x, a
      // separate v2 JSON API on 1.18+. The harness uses the classic routes.
      const apiCreate = await fetch(`${server.baseUrl}/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ metadata: { client: "openclaw-code-agent" } }),
        signal: AbortSignal.timeout(5_000),
      });
      await apiCreate.body?.cancel();

      const permission = [
        { permission: "edit", pattern: "*", action: "ask" },
        { permission: "bash", pattern: "*", action: "ask" },
      ];
      const created = await requestJson<{ id: string }>(server, "POST", "/session", {
        metadata: { client: "openclaw-code-agent-route-smoke" },
        permission,
      });
      assert.equal(created.status, 200);
      assert.match(created.data.id, /^ses/);

      const messages = await requestJson<unknown[]>(server, "GET", `/session/${created.data.id}/message`);
      assert.equal(Array.isArray(messages.data), true);

      const statuses = await requestJson<Record<string, unknown>>(server, "GET", "/session/status");
      assert.equal(typeof statuses.data, "object");

      const forked = await requestJson<{ id: string }>(server, "POST", `/session/${created.data.id}/fork`, {});
      assert.match(forked.data.id, /^ses/);

      await requestNoContent(server, "POST", `/session/${created.data.id}/prompt_async`, {
        noReply: true,
        parts: [{ type: "text", text: "OPENCLAW_OPENCODE_ROUTE_SMOKE" }],
      });

      const abort = await requestJson<boolean>(server, "POST", `/session/${created.data.id}/abort`);
      assert.equal(abort.data, true);

      // The harness demultiplexes one shared stream for every project directory.
      const events = await fetch(`${server.baseUrl}/global/event`, { signal: AbortSignal.timeout(5_000) });
      assert.match(events.headers.get("content-type") ?? "", /text\/event-stream/);
      await events.body?.cancel();
    } finally {
      await server.close();
    }
  });

  it("runs a trivial prompt through opencode serve", { skip: !RUN_COMPLETION }, async () => {
    assertOpenCodeVersion();

    const harness = new OpenCodeHarness({ requestTimeoutMs: 45_000, serverIdleShutdownMs: 0 });
    const messages = await collectUntilCompleted(harness.launch({
      prompt: "Reply with exactly: OPENCLAW_OPENCODE_SMOKE",
      cwd: process.cwd(),
      permissionMode: "default",
      ...(SMOKE_MODEL ? { model: SMOKE_MODEL } : {}),
    }));

    const result = messages.find((message) => message.type === "run_completed") as Extract<HarnessMessage, { type: "run_completed" }> | undefined;
    assert.equal(result?.data.success, true);
    assert.match(result?.data.result ?? messages.map((message) => message.type === "text_delta" ? message.text : "").join(""), /OPENCLAW_OPENCODE_SMOKE/);
  });
});
