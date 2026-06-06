import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { OpenCodeHarness } from "../src/harness/opencode";
import type { HarnessMessage } from "../src/harness/types";

const RUN_LIVE = process.env.OPENCLAW_RUN_LIVE_OPENCODE_SMOKE === "1";
const RUN_COMPLETION = process.env.OPENCLAW_RUN_LIVE_OPENCODE_COMPLETION_SMOKE === "1";

type LiveServer = {
  baseUrl: string;
  cwd: string;
  close(): Promise<void>;
};

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("Could not allocate OpenCode smoke test port."));
        }
      });
    });
  });
}

async function startLiveServer(): Promise<LiveServer> {
  const cwd = await mkdtemp(join(tmpdir(), "openclaw-opencode-smoke-"));
  const port = await getFreePort();
  const child = spawn("opencode", [
    "serve",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });

  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    if (child.exitCode !== null) {
      throw new Error(`OpenCode server exited before route smoke readiness: ${output.trim()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        return {
          baseUrl,
          cwd,
          async close(): Promise<void> {
            if (child.exitCode === null) child.kill("SIGTERM");
            await new Promise<void>((resolve) => {
              const timeout = setTimeout(() => {
                if (child.exitCode === null) child.kill("SIGKILL");
                resolve();
              }, 2_000);
              child.once("exit", () => {
                clearTimeout(timeout);
                resolve();
              });
            });
            await rm(cwd, { recursive: true, force: true });
          },
        };
      }
    } catch {
      // Keep polling until the bounded readiness deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  child.kill("SIGTERM");
  await rm(cwd, { recursive: true, force: true });
  throw new Error(`Timed out waiting for OpenCode server route smoke readiness: ${output.trim()}`);
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
  const version = execFileSync("opencode", ["--version"], { encoding: "utf8" }).trim();
  const [major, minor] = version.split(".").map((part) => Number.parseInt(part, 10));
  assert.ok(major > 1 || (major === 1 && minor >= 16), `expected opencode >= 1.16, got ${version}`);
}

describe("OpenCode live server smoke", { skip: !RUN_LIVE }, () => {
  it("validates the real classic lifecycle route contract without model inference", async () => {
    assertOpenCodeVersion();
    const server = await startLiveServer();
    try {
      const invalidApiCreate = await fetch(`${server.baseUrl}/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ metadata: { client: "openclaw-code-agent" } }),
        signal: AbortSignal.timeout(5_000),
      });
      assert.match(
        invalidApiCreate.headers.get("content-type") ?? "",
        /text\/html/,
        "POST /api/session should not be treated as the OpenCode lifecycle JSON create route",
      );

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
    } finally {
      await server.close();
    }
  });

  it("runs a trivial prompt through opencode serve", { skip: !RUN_COMPLETION }, async () => {
    assertOpenCodeVersion();

    const harness = new OpenCodeHarness({ requestTimeoutMs: 45_000 });
    const messages = await collectUntilCompleted(harness.launch({
      prompt: "Reply with exactly: OPENCLAW_OPENCODE_SMOKE",
      cwd: process.cwd(),
      permissionMode: "default",
    }));

    const result = messages.find((message) => message.type === "run_completed") as Extract<HarnessMessage, { type: "run_completed" }> | undefined;
    assert.equal(result?.data.success, true);
    assert.match(result?.data.result ?? messages.map((message) => message.type === "text_delta" ? message.text : "").join(""), /OPENCLAW_OPENCODE_SMOKE/);
  });
});
