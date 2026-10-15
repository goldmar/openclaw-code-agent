import { readFileSync } from "node:fs";
import {
  checkProtocol,
  openCodeEventErrors,
  openCodeLogErrors,
  openCodeRequestErrors,
  openCodeResponseErrors,
} from "./protocol-schema";
import type { OpenCodeEvent } from "../src/harness/opencode/protocol/events";
import type { OpenCodeServerHandle } from "../src/harness/opencode";
export type OpenCodeRequest = {
  method: string;
  path: string;
  body?: Record<string, any>;
};
const tokens = {
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
};
const schemas = JSON.parse(
  readFileSync(
    new URL("./protocol/opencode-events.schema.json", import.meta.url),
    "utf8",
  ),
);
const durableTypes = new Set<string>(
  Object.values(schemas.$defs as Record<string, any>)
    .filter((v) => v.properties?.durable)
    .map((v) => v.properties.type.const ?? v.properties.type.enum?.[0]),
);
export class OpenCodeFakeServer {
  readonly requests: OpenCodeRequest[] = [];
  readonly protocolViolations: string[] = [];
  readonly sessions = new Map<string, any>();
  readonly records = new Map<string, any[]>();
  readonly logs = new Map<string, OpenCodeEvent[]>();
  readonly inbox = new Map<string, any[]>();
  readonly permissions = new Map<string, any>();
  readonly forms = new Map<string, any>();
  readonly instructions = new Map<string, string>();
  readonly streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  readonly replyWaiters = new Map<string, (request: OpenCodeRequest) => void>();
  readonly busy = new Set<string>();
  autoComplete = false;
  version = "2.0.29";
  modelList: any[] = [];
  onPrompt: ((id: string, text: string, delivery: string) => void) | undefined;
  override: ((request: OpenCodeRequest) => Response | undefined) | undefined;
  private count = 0;
  private eventCount = 0;
  private exits = new Set<(reason: string) => void>();
  handle(): OpenCodeServerHandle {
    return {
      baseUrl: "http://opencode.test",
      onExit: (listener) => {
        this.exits.add(listener);
      },
      close: async () => {
        this.dropStreams();
      },
    };
  }
  crash(): void {
    this.dropStreams();
    for (const exit of this.exits) exit("OpenCode server exited");
    this.exits.clear();
  }
  create(directory = "/tmp", agent = "build", model?: any): any {
    const id = `ses_${++this.count}`;
    const info = {
      id,
      projectID: "prj_test",
      location: { directory },
      cost: 0,
      tokens: structuredClone(tokens),
      time: { created: Date.now(), updated: Date.now() },
      agent,
      ...(model ? { model } : {}),
    };
    this.sessions.set(id, info);
    this.records.set(id, []);
    this.inbox.set(id, []);
    return info;
  }
  private json(req: OpenCodeRequest, value: unknown, status = 200): Response {
    checkProtocol(
      this.protocolViolations,
      `OpenCode ${req.method} ${req.path} response`,
      openCodeResponseErrors(req.method, req.path, status, value),
    );
    return new Response(status === 204 ? null : JSON.stringify(value), {
      status,
      headers: status === 204 ? {} : { "content-type": "application/json" },
    });
  }
  event(
    type: string,
    data: Record<string, unknown>,
    broadcast = true,
  ): OpenCodeEvent {
    const sessionID = String(data.sessionID ?? "");
    const log = this.logs.get(sessionID) ?? [];
    const frame = {
      id: `evt_${++this.eventCount}`,
      created: Date.now(),
      type,
      data,
      ...(durableTypes.has(type)
        ? {
            durable: {
              aggregateID: sessionID,
              seq: log.length,
              version: [
                "session.forked",
                "session.tool.success",
                "session.tool.failed",
              ].includes(type)
                ? 2
                : 1,
            },
          }
        : {}),
    } as OpenCodeEvent;
    checkProtocol(
      this.protocolViolations,
      `OpenCode ${type}`,
      openCodeEventErrors(frame),
    );
    if ("durable" in frame) {
      log.push(frame);
      this.logs.set(sessionID, log);
    }
    if (broadcast)
      for (const stream of this.streams)
        try {
          stream.enqueue(
            new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`),
          );
        } catch {
          /*closed*/
        }
    return frame;
  }
  deliver(sessionID: string, id: string): void {
    this.inbox.set(
      sessionID,
      (this.inbox.get(sessionID) ?? []).filter((i) => i.id !== id),
    );
    this.records.get(sessionID)!.push({
      id,
      type: "user",
      text: "prompt",
      time: { created: Date.now() },
    });
    this.busy.add(sessionID);
    this.event("session.inbox.delivered", { sessionID, inboxID: id });
    this.event("session.execution.started", { sessionID });
  }
  end(
    sessionID: string,
    text = "Done.",
    outcome: "succeeded" | "failed" | "interrupted" = "succeeded",
    reason = "user",
  ): void {
    const assistantMessageID = `msg_asst_${++this.count}`;
    this.event("session.step.started", {
      sessionID,
      assistantMessageID,
      agent: "build",
      model: { providerID: "opencode", id: "test" },
      started: Date.now(),
    });
    this.event("session.text.started", {
      sessionID,
      assistantMessageID,
      ordinal: 0,
    });
    this.event("session.text.delta", {
      sessionID,
      assistantMessageID,
      ordinal: 0,
      delta: text,
    });
    this.event("session.text.ended", {
      sessionID,
      assistantMessageID,
      ordinal: 0,
      text,
    });
    this.event("session.step.ended", {
      sessionID,
      assistantMessageID,
      finish: "stop",
      cost: 0,
      tokens,
    });
    const info = this.sessions.get(sessionID);
    info.outcome = outcome;
    info.time.idle = Date.now();
    this.busy.delete(sessionID);
    this.event(`session.execution.${outcome}`, {
      sessionID,
      ...(outcome === "failed"
        ? { error: { type: "test_error", message: "failed" } }
        : {}),
      ...(outcome === "interrupted" ? { reason } : {}),
    });
  }
  dropStreams(): void {
    for (const stream of this.streams)
      try {
        stream.error(new Error("socket hang up"));
      } catch {
        /*closed*/
      }
    this.streams.clear();
  }
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const method = init?.method ?? "GET";
    const path = url.pathname;
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const req = { method, path, body };
    this.requests.push(req);
    checkProtocol(
      this.protocolViolations,
      `OCA ${method} ${path} request`,
      openCodeRequestErrors(method, path, body),
    );
    const override = this.override?.(req);
    if (override) return override;
    if (path === "/api/info")
      return this.json(req, {
        version: this.version,
        pid: 1,
        urls: [],
        paths: { tmp: "/tmp" },
      });
    if (path === "/api/model")
      return this.json(req, {
        location: { directory: "/tmp" },
        data: this.modelList,
      });
    if (path === "/api/event") {
      let controller: ReadableStreamDefaultController<Uint8Array>;
      return new Response(
        new ReadableStream<Uint8Array>({
          start: (c) => {
            controller = c;
            this.streams.add(c);
            c.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ id: "evt_connected", created: Date.now(), type: "server.connected", data: {} })}\n\n`,
              ),
            );
            init?.signal?.addEventListener(
              "abort",
              () => {
                this.streams.delete(c);
                try {
                  c.close();
                } catch {
                  /*closed*/
                }
              },
              { once: true },
            );
          },
          cancel: () => {
            this.streams.delete(controller);
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    if (path === "/api/session" && method === "GET")
      return this.json(req, {
        data: [...this.sessions.values()].filter(
          (s) => s.parentID === url.searchParams.get("parentID"),
        ),
        cursor: {},
      });
    if (path === "/api/session" && method === "POST")
      return this.json(req, {
        data: this.create(body?.location?.directory, body?.agent, body?.model),
      });
    if (path === "/api/session/active")
      return this.json(req, {
        data: Object.fromEntries(
          [...this.busy].map((id) => [id, { type: "running" }]),
        ),
      });
    const log = /^\/api\/experimental\/session\/([^/]+)\/log$/.exec(path);
    if (log) {
      const items = (this.logs.get(log[1]) ?? []).filter(
        (e) =>
          "durable" in e &&
          (!url.searchParams.has("after") ||
            e.durable.seq > Number(url.searchParams.get("after"))),
      );
      const text = [
        ...items,
        {
          type: "log.synced",
          aggregateID: log[1],
          seq: Math.max(0, (this.logs.get(log[1]) ?? []).length - 1),
        },
      ]
        .map((e) => {
          checkProtocol(
            this.protocolViolations,
            "OpenCode session log",
            openCodeLogErrors(e),
          );
          return `data: ${JSON.stringify(e)}\n\n`;
        })
        .join("");
      return new Response(text, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (path.includes("/instructions/entries/")) {
      if (method === "PUT") this.instructions.set(path, body.value);
      return this.json(req, undefined, 204);
    }
    const match = /^\/api\/session\/([^/]+)(.*)$/.exec(path);
    if (!match) throw new Error(`Unexpected ${method} ${path}`);
    const id = match[1];
    const suffix = match[2];
    const info = this.sessions.get(id);
    if (!info)
      return new Response(JSON.stringify({ _tag: "SessionNotFoundError" }), {
        status: 404,
      });
    if (suffix === "" && method === "GET")
      return this.json(req, { data: info });
    if (suffix === "" && method === "PATCH") {
      Object.assign(info, body);
      return this.json(req, undefined, 204);
    }
    if (suffix === "/agent" || suffix === "/model") {
      Object.assign(info, body);
      return this.json(req, undefined, 204);
    }
    if (suffix === "/permission" && method === "GET")
      return this.json(req, {
        data: [...this.permissions.values()].filter((p) => p.sessionID === id),
      });
    if (suffix === "/form" && method === "GET")
      return this.json(req, {
        data: [...this.forms.values()].filter((f) => f.sessionID === id),
      });
    if (suffix === "/inbox")
      return this.json(req, { data: this.inbox.get(id) ?? [] });
    if (suffix.startsWith("/inbox/") && method === "DELETE") {
      this.inbox.set(
        id,
        (this.inbox.get(id) ?? []).filter(
          (i) => i.id !== suffix.split("/").at(-1),
        ),
      );
      return this.json(req, undefined, 204);
    }
    if (suffix === "/message")
      return this.json(req, {
        data: [...(this.records.get(id) ?? [])]
          .reverse()
          .slice(0, Number(url.searchParams.get("limit") ?? 100)),
        cursor: {},
      });
    if (suffix.startsWith("/message/")) {
      const record = this.records
        .get(id)
        ?.find((m) => m.id === suffix.split("/").at(-1));
      return record
        ? this.json(req, { data: record })
        : new Response(
            JSON.stringify({ _tag: "SessionMessageNotFoundError" }),
            { status: 404 },
          );
    }
    if (suffix === "/fork") {
      const fork = this.create(info.location.directory, info.agent, info.model);
      return this.json(req, { data: fork });
    }
    if (suffix === "/revert/stage")
      return this.json(req, { data: { messageID: body.messageID } });
    if (suffix === "/revert/commit") return this.json(req, undefined, 204);
    if (["/prompt", "/compact", "/synthetic"].includes(suffix)) {
      const inboxID = body.id ?? `msg_${++this.count}`;
      const item = {
        id: inboxID,
        sessionID: id,
        time: { created: Date.now() },
        type:
          suffix === "/compact"
            ? "compaction"
            : suffix === "/synthetic"
              ? "synthetic"
              : "user",
        payload: suffix === "/compact" ? {} : { text: body.text },
        delivery: body.delivery ?? "queue",
      };
      this.inbox.get(id)!.push(item);
      if (body.resume !== false)
        queueMicrotask(() => {
          if (!this.busy.has(id) || body.delivery !== "steer")
            this.deliver(id, inboxID);
          else {
            this.inbox.set(
              id,
              this.inbox.get(id)!.filter((i) => i.id !== inboxID),
            );
            this.records.get(id)!.push({
              id: inboxID,
              type: "user",
              text: body.text,
              time: { created: Date.now() },
            });
            this.event("session.inbox.delivered", { sessionID: id, inboxID });
          }
          this.onPrompt?.(id, body.text ?? "", body.delivery ?? "queue");
          if (this.autoComplete) this.end(id);
        });
      return this.json(req, { data: item });
    }
    if (suffix === "/interrupt") {
      if (this.busy.has(id)) this.end(id, "", "interrupted");
      return this.json(req, { interrupted: true });
    }
    const reply = /^\/(permission|form)\/([^/]+)(\/reply)?$/.exec(suffix);
    if (reply) {
      const requestID = reply[2];
      this.replyWaiters.get(requestID)?.(req);
      this.replyWaiters.delete(requestID);
      if (reply[1] === "permission") {
        const ids =
          body.decision === "reject"
            ? [...this.permissions.values()]
                .filter((p) => p.sessionID === id)
                .map((p) => p.id)
            : [requestID];
        for (const rid of ids) {
          this.permissions.delete(rid);
          this.event("permission.replied", {
            sessionID: id,
            requestID: rid,
            reply: body.decision,
          });
        }
      } else {
        this.forms.delete(requestID);
        this.event(method === "DELETE" ? "form.cancelled" : "form.replied", {
          sessionID: id,
          id: requestID,
          ...(method === "DELETE" ? {} : { answer: body.answer }),
        });
      }
      return this.json(req, undefined, 204);
    }
    throw new Error(`Unexpected ${method} ${path}`);
  };
  askPermission(
    sessionID: string,
    description: string,
  ): Promise<OpenCodeRequest> {
    const value = {
      id: `per_${++this.count}`,
      sessionID,
      action: "shell",
      resources: [description],
    };
    this.permissions.set(value.id, value);
    this.event("permission.asked", value);
    return new Promise((resolve) => this.replyWaiters.set(value.id, resolve));
  }
  askForm(sessionID: string, fields: unknown[]): Promise<OpenCodeRequest> {
    const value = {
      id: `frm_${++this.count}`,
      sessionID,
      title: "Questions",
      metadata: { kind: "question" },
      fields,
    };
    this.forms.set(value.id, value);
    this.event("form.created", { form: value });
    return new Promise((resolve) => this.replyWaiters.set(value.id, resolve));
  }
}
