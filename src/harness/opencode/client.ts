import type { Operations } from "./protocol/api";
import { OpenCodeApiError, isConnectionResetError } from "./errors";
export type FetchLike = typeof fetch;
type Data<T> = T extends { data: infer D } ? D : T;
export class OpenCodeClient {
  constructor(
    readonly baseUrl: string,
    readonly authorization?: string,
    private readonly fetcher: FetchLike = fetch,
    private readonly timeoutMs = 60_000,
  ) {}
  async raw(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    stream = false,
  ): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error("OpenCode request timed out")),
        this.timeoutMs,
      );
      try {
        const response = await this.fetcher(this.baseUrl + path, {
          method,
          headers: {
            connection: "close",
            ...(this.authorization
              ? { Authorization: this.authorization }
              : {}),
            ...(body !== undefined
              ? { "content-type": "application/json" }
              : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: signal
            ? AbortSignal.any([signal, controller.signal])
            : controller.signal,
        });
        if (method === "GET" && response.status === 503 && attempt < 3) {
          await response.body?.cancel();
          continue;
        }
        if (!response.ok) {
          const content = await response.text();
          let value: { _tag?: string; message?: string } = {};
          try {
            value = JSON.parse(content);
          } catch {
            /* non-JSON proxy/server error */
          }
          throw new OpenCodeApiError(
            response.status,
            value._tag ?? `http_${response.status}`,
            value.message ??
              `OpenCode HTTP ${response.status} (${content.startsWith("<") ? "HTML response; check the server URL/version" : "non-success response"})`,
          );
        }
        if (
          !stream &&
          response.status !== 204 &&
          !response.headers.get("content-type")?.includes("json")
        )
          throw new OpenCodeApiError(
            response.status,
            "non_json",
            "OpenCode returned HTML or non-JSON; check the server URL/version",
          );
        return response;
      } catch (e) {
        if (
          method === "GET" &&
          attempt < 1 &&
          isConnectionResetError(e) &&
          !signal?.aborted
        )
          continue;
        throw e;
      } finally {
        clearTimeout(timer);
      }
    }
  }
  async request<K extends keyof Operations>(
    operation: K,
    params: Record<string, string> = {},
    body?: Operations[K]["request"],
    query = "",
  ): Promise<Operations[K]["response"]> {
    const [method, template] = operation.split(" ");
    const path = template.replace(/\{([^}]+)\}/g, (_, key: string) =>
      encodeURIComponent(params[key] ?? ""),
    );
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("OpenCode response body timed out")),
      this.timeoutMs,
    );
    try {
      const response = await this.raw(
        method,
        path + query,
        body,
        controller.signal,
      );
      if (response.status === 204)
        return undefined as Operations[K]["response"];
      return (await response.json()) as Operations[K]["response"];
    } finally {
      clearTimeout(timer);
    }
  }
  async data<K extends keyof Operations>(
    operation: K,
    params: Record<string, string> = {},
    body?: Operations[K]["request"],
    query = "",
  ): Promise<Data<Operations[K]["response"]>> {
    const value = await this.request(operation, params, body, query);
    return (
      value && typeof value === "object" && "data" in value ? value.data : value
    ) as Data<Operations[K]["response"]>;
  }
}
