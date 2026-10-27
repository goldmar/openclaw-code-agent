import "./test-env";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fetchToken } from "@modelcontextprotocol/sdk/client/auth.js";
import { ClientCredentialsProvider } from "@modelcontextprotocol/sdk/client/auth-extensions.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";

const runtime = { fetchToken, ClientCredentialsProvider, StreamableHTTPClientTransport, InMemoryTaskStore, requireBearerAuth };

// Resolve from each actual SDK package, rather than accidentally testing only
// OCA's already-patched direct dependency. realpath matters for pnpm's layout.
function hostMcp(role: "openclaw-baseline" | "openclaw"): typeof runtime {
  const host = realpathSync(new URL(`../node_modules/${role}`, import.meta.url));
  const require = createRequire(join(host, "package.json"));
  return {
    fetchToken: require("@modelcontextprotocol/sdk/client/auth.js").fetchToken,
    ClientCredentialsProvider: require("@modelcontextprotocol/sdk/client/auth-extensions.js").ClientCredentialsProvider,
    StreamableHTTPClientTransport: require("@modelcontextprotocol/sdk/client/streamableHttp.js").StreamableHTTPClientTransport,
    InMemoryTaskStore: require("@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js").InMemoryTaskStore,
    requireBearerAuth: require("@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js").requireBearerAuth,
  };
}

for (const [role, sdk] of [
  ["runtime", runtime],
  ["baseline", hostMcp("openclaw-baseline")],
  ["development", hostMcp("openclaw")],
] as const) {
  describe(`MCP dependency security regressions (${role})`, () => {
    const { fetchToken, ClientCredentialsProvider, StreamableHTTPClientTransport, InMemoryTaskStore, requireBearerAuth } = sdk;
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

    it("does not resend OAuth client credentials across origins", async () => {
      const provider = new ClientCredentialsProvider({
        clientId: "fixture-client",
        clientSecret: "fixture-secret",
        expectedIssuer: "https://issuer.example.test",
      });
      const requests: string[] = [];
      await assert.rejects(fetchToken(provider, new URL("https://issuer.example.test"), {
        fetchFn: async (url, init) => {
          assert.equal(init?.redirect, "manual");
          requests.push(String(url));
          return Response.json({ error: "invalid_request", error_description: "cross-origin fixture" }, {
            status: 307,
            headers: { location: "https://other.example.test/token" },
          });
        },
      }), /cross-origin fixture/u);
      assert.deepEqual(requests, ["https://issuer.example.test/token"]);
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

    it("requires the configured audience and records that checking remains opt-in", async () => {
      const expectedResource = new URL("https://server.example.test/mcp");
      for (const [resource, enforceAudience, allowed] of [
        [expectedResource, true, true],
        [new URL("https://other.example.test/mcp"), true, false],
        [undefined, true, false],
        [new URL("https://other.example.test/mcp"), false, true],
      ] as const) {
        const authInfo = {
          token: "fixture-token",
          clientId: "fixture-client",
          scopes: [],
          expiresAt: Date.now() / 1000 + 60,
          ...(resource ? { resource } : {}),
        };
        const middleware = requireBearerAuth({
          verifier: { verifyAccessToken: async () => authInfo },
          ...(enforceAudience ? { expectedResource } : {}),
        });
        type Middleware = typeof middleware;
        let status = 200;
        let nextCalls = 0;
        const request = { headers: { authorization: "Bearer fixture-token" }, auth: undefined as typeof authInfo | undefined };
        const response = {
          set: () => response,
          status: (value: number) => { status = value; return response; },
          json: () => response,
        };
        // The middleware touches only these Express fields; keep the fixture at
        // that boundary rather than constructing an unrelated HTTP application.
        await middleware(
          request as unknown as Parameters<Middleware>[0],
          response as unknown as Parameters<Middleware>[1],
          () => { nextCalls += 1; },
        );
        assert.equal(status, allowed ? 200 : 401);
        assert.equal(nextCalls, allowed ? 1 : 0);
        assert.equal(request.auth, allowed ? authInfo : undefined);
      }
    });
  });
}
