/**
 * Validates fake-backend wire shapes against the vendored protocol schemas:
 *
 * - tests/protocol/codex-app-server.schema.json: Codex App Server JSON Schema
 *   (`pnpm sync:codex-protocol`),
 * - tests/protocol/opencode-openapi.json: OpenCode server OpenAPI document
 *   (`pnpm sync:opencode-openapi`).
 *
 * The validator is a small JSON Schema subset interpreter covering every
 * keyword those two documents use (draft-07 plus the OpenAPI 3.1 additions
 * `prefixItems` and numeric `exclusiveMinimum`); `format`, `default`, and
 * annotations are ignored. It throws on any keyword it does not know, so a
 * schema refresh that starts using a new keyword fails loudly instead of
 * validating less.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

type JsonSchema = boolean | { [keyword: string]: unknown };

const IGNORED_KEYWORDS = new Set([
  "$schema", "$comment", "$id", "title", "description", "default", "examples", "format", "deprecated",
  "readOnly", "writeOnly", "contentMediaType", "contentEncoding", "discriminator",
]);
const HANDLED_KEYWORDS = new Set([
  "$ref", "type", "enum", "const", "properties", "required", "additionalProperties", "patternProperties",
  "propertyNames", "items", "prefixItems", "minItems", "maxItems", "uniqueItems", "minimum", "maximum",
  "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "pattern", "anyOf", "oneOf", "allOf", "not",
  // Nested definition containers are only reached through $ref.
  "definitions", "v2",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "null": return value === null;
    case "array": return Array.isArray(value);
    case "object": return isRecord(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "string": return typeof value === "string";
    case "boolean": return typeof value === "boolean";
    default: throw new Error(`protocol-schema: unknown JSON Schema type ${type}`);
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A schema document whose `$ref`s are JSON pointers into itself. */
export class SchemaDocument {
  private readonly patternCache = new Map<string, RegExp>();

  constructor(readonly root: Record<string, unknown>) {}

  resolve(ref: string): JsonSchema {
    if (!ref.startsWith("#/")) throw new Error(`protocol-schema: only local $refs are supported, got ${ref}`);
    let node: unknown = this.root;
    for (const segment of ref.slice(2).split("/")) {
      const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
      if (!isRecord(node) || !(key in node)) throw new Error(`protocol-schema: unresolved $ref ${ref}`);
      node = node[key];
    }
    return node as JsonSchema;
  }

  /** Validation errors (empty when `value` matches `schema`). */
  validate(value: unknown, schema: JsonSchema, path = "$"): string[] {
    const errors: string[] = [];
    this.check(value, schema, path, errors);
    return errors;
  }

  private regex(pattern: string): RegExp {
    let compiled = this.patternCache.get(pattern);
    if (!compiled) {
      compiled = new RegExp(pattern, "u");
      this.patternCache.set(pattern, compiled);
    }
    return compiled;
  }

  private check(value: unknown, schema: JsonSchema, path: string, errors: string[]): void {
    if (schema === true) return;
    if (schema === false) {
      errors.push(`${path}: no value is allowed here`);
      return;
    }
    for (const keyword of Object.keys(schema)) {
      if (!HANDLED_KEYWORDS.has(keyword) && !IGNORED_KEYWORDS.has(keyword) && !keyword.startsWith("x-")) {
        throw new Error(`protocol-schema: unsupported JSON Schema keyword "${keyword}" at ${path}`);
      }
    }

    if (typeof schema.$ref === "string") this.check(value, this.resolve(schema.$ref), path, errors);

    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? schema.type as string[] : [schema.type as string];
      if (!types.some((type) => matchesType(value, type))) {
        errors.push(`${path}: expected ${types.join(" | ")}, got ${typeOf(value)}`);
        return;
      }
    }
    if (Array.isArray(schema.enum) && !schema.enum.some((entry) => deepEqual(entry, value))) {
      errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
    }
    if ("const" in schema && !deepEqual(schema.const, value)) {
      errors.push(`${path}: expected ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
    }

    if (typeof value === "number") {
      if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
      if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${path}: ${value} > maximum ${schema.maximum}`);
      if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) errors.push(`${path}: ${value} <= exclusiveMinimum ${schema.exclusiveMinimum}`);
      if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) errors.push(`${path}: ${value} >= exclusiveMaximum ${schema.exclusiveMaximum}`);
    }
    if (typeof value === "string") {
      if (typeof schema.minLength === "number" && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
      if (typeof schema.maxLength === "number" && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
      if (typeof schema.pattern === "string" && !this.regex(schema.pattern).test(value)) {
        errors.push(`${path}: ${JSON.stringify(value)} does not match /${schema.pattern}/`);
      }
    }

    if (Array.isArray(value)) {
      if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
      if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
      if (schema.uniqueItems === true && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) errors.push(`${path}: items are not unique`);
      const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems as JsonSchema[] : [];
      prefix.forEach((itemSchema, index) => {
        if (index < value.length) this.check(value[index], itemSchema, `${path}[${index}]`, errors);
      });
      if (Array.isArray(schema.items)) {
        (schema.items as JsonSchema[]).forEach((itemSchema, index) => {
          if (index < value.length) this.check(value[index], itemSchema, `${path}[${index}]`, errors);
        });
      } else if (schema.items !== undefined) {
        for (let index = prefix.length; index < value.length; index += 1) {
          this.check(value[index], schema.items as JsonSchema, `${path}[${index}]`, errors);
        }
      }
    }

    if (isRecord(value)) {
      const properties = isRecord(schema.properties) ? schema.properties as Record<string, JsonSchema> : {};
      const patternProperties = isRecord(schema.patternProperties) ? schema.patternProperties as Record<string, JsonSchema> : {};
      for (const key of Array.isArray(schema.required) ? schema.required as string[] : []) {
        if (!(key in value)) errors.push(`${path}: missing required property "${key}"`);
      }
      for (const [key, child] of Object.entries(value)) {
        const childPath = `${path}.${key}`;
        let matched = false;
        if (key in properties) {
          matched = true;
          this.check(child, properties[key]!, childPath, errors);
        }
        for (const [pattern, patternSchema] of Object.entries(patternProperties)) {
          if (this.regex(pattern).test(key)) {
            matched = true;
            this.check(child, patternSchema, childPath, errors);
          }
        }
        if (!matched && schema.additionalProperties !== undefined) {
          if (schema.additionalProperties === false) errors.push(`${path}: unexpected property "${key}"`);
          else this.check(child, schema.additionalProperties as JsonSchema, childPath, errors);
        }
        if (schema.propertyNames !== undefined) this.check(key, schema.propertyNames as JsonSchema, `${childPath}<name>`, errors);
      }
    }

    if (Array.isArray(schema.allOf)) {
      for (const sub of schema.allOf as JsonSchema[]) this.check(value, sub, path, errors);
    }
    if (Array.isArray(schema.anyOf)) {
      const branches = (schema.anyOf as JsonSchema[]).map((sub) => this.validate(value, sub, path));
      if (!branches.some((branch) => branch.length === 0)) errors.push(this.describeBranches(path, "anyOf", branches));
    }
    if (Array.isArray(schema.oneOf)) {
      const branches = (schema.oneOf as JsonSchema[]).map((sub) => this.validate(value, sub, path));
      const passing = branches.filter((branch) => branch.length === 0).length;
      if (passing === 0) errors.push(this.describeBranches(path, "oneOf", branches));
      else if (passing > 1) errors.push(`${path}: matches ${passing} oneOf branches, expected exactly one`);
    }
    if (schema.not !== undefined && this.validate(value, schema.not as JsonSchema, path).length === 0) {
      errors.push(`${path}: matches a schema it must not match`);
    }
  }

  /** Report the closest failing union branch (fewest errors) to keep messages readable. */
  private describeBranches(path: string, keyword: string, branches: string[][]): string {
    const closest = [...branches].sort((a, b) => a.length - b.length)[0] ?? [];
    return `${path}: matches no ${keyword} branch; closest branch: ${closest.slice(0, 3).join("; ")}`;
  }
}

const protocolDir = join(import.meta.dirname, "protocol");
let codexDocument: SchemaDocument | undefined;
let openCodeDocument: SchemaDocument | undefined;

function codex(): SchemaDocument {
  codexDocument ??= new SchemaDocument(JSON.parse(readFileSync(join(protocolDir, "codex-app-server.schema.json"), "utf8")) as Record<string, unknown>);
  return codexDocument;
}

function openCode(): SchemaDocument {
  openCodeDocument ??= new SchemaDocument(JSON.parse(readFileSync(join(protocolDir, "opencode-openapi.json"), "utf8")) as Record<string, unknown>);
  return openCodeDocument;
}

type CodexMethodEntry = { params: JsonSchema; paramsRequired: boolean; result?: JsonSchema };

function codexEntry(section: "clientRequests" | "serverNotifications" | "serverRequests", method: string): CodexMethodEntry {
  const entries = codex().root[section] as Record<string, CodexMethodEntry>;
  const entry = entries[method];
  if (!entry) {
    throw new Error(`protocol-schema: ${method} is not in the vendored Codex ${section}; add it to scripts/sync-codex-protocol.mjs and run pnpm sync:codex-protocol`);
  }
  return entry;
}

function codexParams(section: "clientRequests" | "serverNotifications" | "serverRequests", method: string, params: unknown): string[] {
  const entry = codexEntry(section, method);
  if (params === undefined) return entry.paramsRequired ? [`$: ${method} requires params`] : [];
  return codex().validate(params, entry.params);
}

/** Params OCA sends with a Codex client request. */
export function codexClientRequestErrors(method: string, params: unknown): string[] {
  return codexParams("clientRequests", method, params);
}

/** Result the app server returns for a Codex client request. */
export function codexClientResultErrors(method: string, result: unknown): string[] {
  return codex().validate(result, codexEntry("clientRequests", method).result!);
}

/** Params of a Codex server notification. */
export function codexNotificationErrors(method: string, params: unknown): string[] {
  return codexParams("serverNotifications", method, params);
}

/** Params of a Codex server-initiated request. */
export function codexServerRequestErrors(method: string, params: unknown): string[] {
  return codexParams("serverRequests", method, params);
}

/** Result OCA returns for a Codex server-initiated request. */
export function codexServerResultErrors(method: string, result: unknown): string[] {
  return codex().validate(result, codexEntry("serverRequests", method).result!);
}

type OpenApiOperation = {
  requestBody?: { content?: Record<string, { schema?: JsonSchema }> };
  responses?: Record<string, { content?: Record<string, { schema?: JsonSchema }> }>;
};

const operationPatterns = new Map<string, RegExp>();

function openCodeOperation(method: string, path: string): { template: string; operation: OpenApiOperation } {
  const paths = openCode().root.paths as Record<string, Record<string, OpenApiOperation>>;
  const verb = method.toLowerCase();
  for (const [template, operations] of Object.entries(paths)) {
    let pattern = operationPatterns.get(template);
    if (!pattern) {
      const source = template.split("/").map((segment) => (/^\{.+\}$/.test(segment) ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/");
      pattern = new RegExp(`^${source}$`);
      operationPatterns.set(template, pattern);
    }
    if (pattern.test(path) && operations[verb]) return { template, operation: operations[verb]! };
  }
  throw new Error(`protocol-schema: ${method} ${path} is not in the vendored OpenCode OpenAPI; add it to scripts/sync-opencode-openapi.mjs and run pnpm sync:opencode-openapi`);
}

/** JSON body OCA sends to an OpenCode route. */
export function openCodeRequestErrors(method: string, path: string, body: unknown): string[] {
  const { operation } = openCodeOperation(method, path);
  const schema = operation.requestBody?.content?.["application/json"]?.schema;
  if (!schema) return body === undefined ? [] : [`$: ${method} ${path} takes no JSON body`];
  if (body === undefined) return [];
  return openCode().validate(body, schema);
}

/** Response the OpenCode server returns (JSON body, or no body for 204). */
export function openCodeResponseErrors(method: string, path: string, status: number, body: unknown): string[] {
  const { operation } = openCodeOperation(method, path);
  const response = operation.responses?.[String(status)];
  if (!response) return [`$: ${method} ${path} does not document status ${status}`];
  const schema = response.content?.["application/json"]?.schema;
  if (!schema) return body === undefined ? [] : [`$: ${method} ${path} ${status} has no JSON body`];
  return openCode().validate(body, schema);
}

/** One `/global/event` server-sent event (`{directory, payload}`). */
export function openCodeEventErrors(frame: unknown): string[] {
  const { operation } = openCodeOperation("GET", "/global/event");
  const schema = operation.responses?.["200"]?.content?.["text/event-stream"]?.schema;
  if (!schema) throw new Error("protocol-schema: vendored OpenCode OpenAPI has no /global/event schema");
  return openCode().validate(frame, schema);
}

/** Record and throw a protocol violation so it cannot be swallowed by a harness catch. */
export function checkProtocol(violations: string[], label: string, errors: string[]): void {
  if (errors.length === 0) return;
  const message = `${label} does not match the vendored protocol schema:\n  ${errors.slice(0, 8).join("\n  ")}`;
  violations.push(message);
  throw new Error(message);
}
