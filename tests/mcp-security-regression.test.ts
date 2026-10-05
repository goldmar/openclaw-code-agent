import "./test-env";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchToken } from "@modelcontextprotocol/sdk/client/auth.js";
import { ClientCredentialsProvider } from "@modelcontextprotocol/sdk/client/auth-extensions.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";

describe("MCP dependency security regressions", () => {
  it("sends client credentials only to their configured issuer", async () => {
    const provider = new ClientCredentialsProvider({
      clientId: "fixture-client",
      clientSecret: "fixture-secret",
      expectedIssuer: "https://issuer.example.test",
    });
    let requests = 0;
    const options = {
      fetchFn: async () => {
        requests += 1;
        return Response.json({ access_token: "fixture-token", token_type: "Bearer" });
      },
    };

    await assert.rejects(
      fetchToken(provider, new URL("https://other.example.test"), options),
      /bound to authorization server/u,
    );
    assert.equal(requests, 0);
    const tokens = await fetchToken(provider, new URL("https://issuer.example.test"), options);
    assert.equal(tokens.access_token, "fixture-token");
    assert.equal(requests, 1);
  });

  it("blocks cross-origin redirects while preserving same-origin POST payloads", async () => {
    const endpoint = "https://server.example.test/mcp";
    const message = { jsonrpc: "2.0", id: 1, method: "ping" } as const;
    for (const [location, allowed] of [
      ["https://other.example.test/mcp", false],
      ["/moved", true],
    ] as const) {
      const requests: { url: string; init?: RequestInit }[] = [];
      const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
        requestInit: { headers: { "x-fixture": "preserved" } },
        fetch: async (url, init) => {
          assert.equal(init?.redirect, "manual");
          requests.push({ url: String(url), init });
          return requests.length === 1
            ? new Response(null, { status: 307, headers: { location } })
            : new Response(null, { status: 202 });
        },
      });
      try {
        await transport.start();
        if (allowed) {
          await transport.send(message);
          assert.deepEqual(requests.map((request) => request.url), [endpoint, "https://server.example.test/moved"]);
          for (const { init } of requests) {
            assert.equal(init?.method, "POST");
            assert.equal(init?.body, JSON.stringify(message));
            assert.equal(new Headers(init?.headers).get("x-fixture"), "preserved");
          }
        } else {
          await assert.rejects(transport.send(message), /Redirect.*not followed.*same-origin/u);
          assert.deepEqual(requests.map((request) => request.url), [endpoint]);
        }
      } finally {
        await transport.close();
      }
    }
  });

  it("isolates explicitly session-owned tasks and results", async (t) => {
    const store = new InMemoryTaskStore();
    t.after(() => store.cleanup());
    const task = await store.createTask({ ttl: null }, 1, { method: "ping" }, "owner");
    const result = { content: [{ type: "text", text: "owner-only fixture" }] };
    await store.storeTaskResult(task.taskId, "completed", result, "owner");

    assert.equal((await store.getTask(task.taskId, "owner"))?.status, "completed");
    assert.deepEqual((await store.listTasks(undefined, "owner")).tasks.map((entry) => entry.taskId), [task.taskId]);
    assert.deepEqual(await store.getTaskResult(task.taskId, "owner"), result);
    assert.equal(await store.getTask(task.taskId, "other"), null);
    assert.deepEqual((await store.listTasks(undefined, "other")).tasks, []);
    await assert.rejects(store.getTaskResult(task.taskId, "other"), /not found/u);
  });
});
