import "./test-env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SchemaDocument, codexClientRequestErrors, codexNotificationErrors, openCodeEventErrors } from "./protocol-schema";

describe("protocol schema validator", () => {
  const document = new SchemaDocument({
    definitions: {
      Closed: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
      Tagged: {
        oneOf: [
          { type: "object", properties: { kind: { enum: ["a"] } }, required: ["kind"] },
          { type: "object", properties: { kind: { enum: ["b"] } }, required: ["kind"] },
        ],
      },
      Loose: { oneOf: [{ type: "string" }, { type: "string", minLength: 1 }] },
    },
  });

  it("rejects extra properties, including names inherited from Object.prototype", () => {
    assert.deepEqual(document.validate({ id: "x" }, { $ref: "#/definitions/Closed" }), []);
    assert.match(document.validate({ id: "x", extra: 1 }, { $ref: "#/definitions/Closed" }).join("\n"), /unexpected property "extra"/);
    assert.match(document.validate({ id: "x", constructor: 1 }, { $ref: "#/definitions/Closed" }).join("\n"), /unexpected property "constructor"/);
    assert.match(document.validate({ toString: "x" }, { $ref: "#/definitions/Closed" }).join("\n"), /missing required property "id"/);
  });

  it("requires exactly one oneOf branch", () => {
    assert.deepEqual(document.validate({ kind: "a" }, { $ref: "#/definitions/Tagged" }), []);
    assert.match(document.validate({ kind: "c" }, { $ref: "#/definitions/Tagged" }).join("\n"), /matches no oneOf branch/);
    assert.match(document.validate("text", { $ref: "#/definitions/Loose" }).join("\n"), /matches 2 oneOf branches/);
  });

  it("fails loudly on keywords it does not implement", () => {
    assert.throws(() => document.validate(1, { multipleOf: 2 }), /unsupported JSON Schema keyword "multipleOf"/);
    assert.throws(() => document.validate(1, { $ref: "#/definitions/Missing" }), /unresolved \$ref/);
  });

  it("checks frames against the vendored Codex and OpenCode documents", () => {
    assert.deepEqual(codexNotificationErrors("serverRequest/resolved", { threadId: "t-1", requestId: 3 }), []);
    assert.match(codexNotificationErrors("serverRequest/resolved", { threadId: "t-1" }).join("\n"), /missing required property "requestId"/);
    assert.throws(() => codexClientRequestErrors("constructor", {}), /not in the vendored Codex clientRequests/);
    assert.deepEqual(openCodeEventErrors({ directory: "/tmp", payload: { id: "evt_1", type: "session.idle", properties: { sessionID: "ses_1" } } }), []);
    assert.notDeepEqual(openCodeEventErrors({ directory: "/tmp", payload: { type: "session.idle", properties: { sessionID: "ses_1" } } }), []);
  });
});
