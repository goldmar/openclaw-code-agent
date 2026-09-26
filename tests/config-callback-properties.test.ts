import "./test-env";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { createCallbackHandler } from "../src/callback-handler";
import { getHarnessConfig, pluginConfig, resolveRuntimeBuildSettings, setPluginConfig } from "../src/config";
import { setAutoUpdateService, setSessionManager } from "../src/singletons";
import type { SessionManager } from "../src/session-manager";
import type { HarnessConfig, RawPluginConfig } from "../src/types";
import { propertyParams } from "./property-harness";

/**
 * Properties of plugin config normalization (setPluginConfig) and callback
 * payload handling (createCallbackHandler).
 *
 * Config inputs are generated from the manifest's own `configSchema`, so they
 * are the configs OpenClaw accepts: the schema has `additionalProperties:
 * false`, and OpenClaw refuses to load the plugin with an unknown key (see
 * docs/REFERENCE.md, "Upgrading from 4.x"). Unknown keys that reach
 * setPluginConfig programmatically are ignored.
 */

type JsonSchema = {
  type?: string;
  enum?: readonly unknown[];
  default?: unknown;
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
};

const manifest = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../openclaw.plugin.json"), "utf8"),
) as { configSchema: JsonSchema };
const schema = manifest.configSchema;
const topLevel = schema.properties ?? {};

/** An arbitrary value the schema accepts. */
function arbitraryFor(node: JsonSchema, depth = 0): fc.Arbitrary<unknown> {
  if (node.enum) return fc.constantFrom(...node.enum);
  switch (node.type) {
    case "number":
      return fc.oneof(fc.integer({ min: 0, max: 100_000 }), fc.double({ min: 0, max: 1e6, noNaN: true }));
    case "integer":
      return fc.integer({ min: 0, max: 100_000 });
    case "boolean":
      return fc.boolean();
    case "string":
      return fc.string({ maxLength: 16 });
    case "array":
      return fc.array(node.items ? arbitraryFor(node.items, depth + 1) : fc.string({ maxLength: 8 }), { maxLength: 4 });
    case "object": {
      const known = node.properties
        ? fc.record(Object.fromEntries(Object.entries(node.properties).map(([key, child]) => [key, arbitraryFor(child, depth + 1)])), { requiredKeys: [] })
        : fc.constant({});
      const extra = typeof node.additionalProperties === "object" && depth < 2
        ? fc.dictionary(fc.constantFrom("claude-code", "codex", "opencode", "custom-harness", "/srv/repo"), arbitraryFor(node.additionalProperties, depth + 1), { maxKeys: 3 })
        : fc.constant({});
      return fc.tuple(known, extra).map(([a, b]) => ({ ...b, ...a }));
    }
    default:
      return fc.anything({ maxDepth: 1 });
  }
}

const configArb = arbitraryFor(schema) as fc.Arbitrary<Partial<RawPluginConfig>>;
const BUILTIN_HARNESSES = ["claude-code", "codex", "opencode"];

describe("setPluginConfig (properties)", () => {
  afterEach(() => setPluginConfig({}));

  it("never throws and applies the schema defaults for omitted keys", () => {
    fc.assert(
      fc.property(configArb, (config) => {
        setPluginConfig(config);
        const effective = pluginConfig as unknown as Record<string, unknown>;
        const raw = config as Record<string, unknown>;
        for (const [key, node] of Object.entries(topLevel)) {
          if (key === "harnesses") continue;
          if (raw[key] !== undefined) {
            assert.deepEqual(effective[key], raw[key], `${key} keeps the configured value`);
          } else if (node.default !== undefined) {
            assert.deepEqual(effective[key], node.default, `${key} falls back to the schema default`);
          } else {
            assert.equal(effective[key], undefined, `${key} stays unset`);
          }
        }
        assert.deepEqual(resolveRuntimeBuildSettings(config), {
          maxSessions: pluginConfig.maxSessions,
          maxPersistedSessions: pluginConfig.maxPersistedSessions,
          autoUpdate: pluginConfig.autoUpdate,
        });
      }),
      propertyParams(300),
    );
  });

  it("merges harness settings over the built-in defaults and copies model lists", () => {
    setPluginConfig({});
    const builtins = Object.fromEntries(BUILTIN_HARNESSES.map((name) => [name, structuredClone(getHarnessConfig(name))])) as Record<string, HarnessConfig>;
    fc.assert(
      fc.property(configArb, (config) => {
        setPluginConfig(config);
        for (const name of BUILTIN_HARNESSES) assert.ok(pluginConfig.harnesses[name], `built-in harness ${name} is always configured`);
        for (const [name, value] of Object.entries(config.harnesses ?? {})) {
          const effective = pluginConfig.harnesses[name];
          const builtin = builtins[name] ?? {};
          assert.equal(effective.defaultModel, value.defaultModel ?? builtin.defaultModel, `${name}.defaultModel`);
          assert.equal(effective.reasoningEffort, value.reasoningEffort ?? builtin.reasoningEffort, `${name}.reasoningEffort`);
          if (value.allowedModels !== undefined) {
            assert.deepEqual(effective.allowedModels, value.allowedModels);
            assert.notEqual(effective.allowedModels, value.allowedModels, "allowedModels is copied, not shared");
          } else if (value.defaultModel !== undefined) {
            assert.equal(effective.allowedModels, undefined, "a custom defaultModel without allowedModels lifts the built-in allowlist");
          } else {
            assert.deepEqual(effective.allowedModels, builtin.allowedModels);
          }
        }
      }),
      propertyParams(200),
    );
  });

  it("ignores keys outside the schema", () => {
    const known = new Set([...Object.keys(topLevel), "harnesses"]);
    fc.assert(
      fc.property(configArb, fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }).filter((key) => !known.has(key) && key !== "__proto__"), fc.anything({ maxDepth: 1 }), { maxKeys: 3 }), (config, unknown) => {
        setPluginConfig({ ...config, ...unknown } as Partial<RawPluginConfig>);
        for (const key of Object.keys(pluginConfig)) assert.ok(known.has(key), `unexpected config key ${key}`);
      }),
      propertyParams(100),
    );
  });
});

// -- callback payloads -------------------------------------------------------

type Handler = ReturnType<typeof createCallbackHandler>["handler"];
type Ctx = Parameters<Handler>[0];

function payloadCtx(channel: "telegram" | "discord", payload: string | undefined, authorized: boolean, replies: string[]): Ctx {
  const reply = async ({ text }: { text: string }): Promise<void> => { replies.push(text); };
  const noop = async (): Promise<void> => {};
  const ctx = channel === "telegram"
    ? {
        channel,
        accountId: "bot",
        callbackId: "cb",
        conversationId: "-100123",
        senderId: "1",
        isGroup: true,
        isForum: false,
        auth: { isAuthorizedSender: authorized },
        callback: { data: `code-agent:${payload ?? ""}`, namespace: "code-agent", payload, messageId: 1, chatId: "-100123", messageText: "prompt" },
        respond: { acknowledge: noop, reply, clearButtons: noop, editButtons: noop, editMessage: noop },
      }
    : {
        channel,
        auth: { isAuthorizedSender: authorized },
        interaction: payload === undefined ? {} : { payload },
        respond: { acknowledge: noop, reply, followUp: reply, editMessage: noop, clearComponents: noop },
      };
  // The SDK context types carry many members the handler never reads.
  return ctx as unknown as Ctx;
}

describe("callback payload handling (properties)", () => {
  afterEach(() => {
    setSessionManager(null);
    setAutoUpdateService(null);
  });

  it("never throws, looks up only trimmed non-empty payloads, and replies with a fixed message", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<"telegram" | "discord">("telegram", "discord"),
        fc.option(fc.oneof(fc.string({ maxLength: 40 }), fc.uuid(), fc.constantFrom("", "   ", "code-agent:x", "\n")), { nil: undefined }),
        fc.boolean(),
        async (channel, payload, authorized) => {
          const lookups: string[] = [];
          let consumes = 0;
          const manager = {
            getActionToken: (id: string): undefined => {
              lookups.push(id);
              return undefined;
            },
            consumeActionToken: (): undefined => {
              consumes += 1;
              return undefined;
            },
          };
          setSessionManager(manager as unknown as SessionManager);
          const replies: string[] = [];
          const result = await createCallbackHandler(channel).handler(payloadCtx(channel, payload, authorized, replies));
          assert.deepEqual(result, { handled: true });
          assert.equal(consumes, 0, "an unknown token is never consumed");
          assert.equal(replies.length, 1, JSON.stringify(replies));
          const trimmed = payload?.trim() ?? "";
          if (!authorized) {
            assert.deepEqual(replies, ["⛔ Unauthorized."]);
            assert.deepEqual(lookups, []);
          } else if (!trimmed) {
            assert.deepEqual(replies, ["⚠️ This button is not recognized. Use the buttons on the latest message."]);
            assert.deepEqual(lookups, []);
          } else {
            assert.deepEqual(lookups, [trimmed]);
            assert.deepEqual(replies, ["⚠️ This button has expired or was already used."]);
          }
        },
      ),
      propertyParams(200),
    );
  });

  it("reports a missing service instead of throwing", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom<"telegram" | "discord">("telegram", "discord"), fc.uuid(), async (channel, payload) => {
        setSessionManager(null);
        const replies: string[] = [];
        await createCallbackHandler(channel).handler(payloadCtx(channel, payload, true, replies));
        assert.deepEqual(replies, ["⚠️ The code agent is not running right now. Try again in a moment."]);
      }),
      propertyParams(20),
    );
  });
});
