import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildHarnessChildEnv } from "../../child-env";
import { resolveCodeAgentStateDir } from "../../state-paths";
import { pluginConfig } from "../../config";
import { spawnWithLifeline } from "../process-lifeline";
import { resolveOpenCodeCommand } from "./command";
import { OpenCodeClient, type FetchLike } from "./client";
import {
  checkServerVersion,
  type OpenCodeEndpoint,
  type EndpointLease,
  type OpenCodeServerHandle,
} from "./endpoint";
export interface OpenCodeServerStartOptions {
  fetch?: FetchLike;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
}
export function privateServerEnvironment(
  base: NodeJS.ProcessEnv,
  database: string,
  password: string,
  passEnv: string[] = [],
): NodeJS.ProcessEnv {
  const env = buildHarnessChildEnv(base);
  for (const key of Object.keys(env))
    if (/^OPENCODE_.*PASSWORD$/.test(key)) delete env[key];
  for (const key of passEnv)
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && base[key] !== undefined)
      env[key] = base[key];
  // These cannot be overridden by passEnv.
  for (const key of Object.keys(env))
    if (/^OPENCODE_.*PASSWORD$/.test(key)) delete env[key];
  return { ...env, OPENCODE_PASSWORD: password, OPENCODE_DB: database };
}
export async function startOpenCodeServer(
  options: OpenCodeServerStartOptions = {},
): Promise<OpenCodeServerHandle> {
  const dir = join(resolveCodeAgentStateDir(), "opencode");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const password = randomBytes(32).toString("hex");
  const lifeline = spawnWithLifeline(
    resolveOpenCodeCommand(),
    ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"],
    {
      cwd: tmpdir(),
      stdin: "pipe",
      env: privateServerEnvironment(
        process.env,
        join(dir, "opencode.db"),
        password,
        pluginConfig.harnesses.opencode?.passEnv,
      ),
    },
  );
  const child = lifeline.process;
  let closed = false;
  let exitReason:string|undefined;
  const listeners = new Set<(reason: string) => void>();
  child.on("exit", (code, signal) => {
    exitReason=`OpenCode server exited (${signal ?? code})`;
    if (!closed)
      for (const listener of listeners)listener(exitReason);
  });
  // Drain diagnostics without copying server environment or credentials into logs.
  child.stderr.resume();
  child.stdin.on("error", (): void => {
    /* Process exit is reported through onExit. */
  });
  try {
    const baseUrl = await new Promise<string>((accept, reject) => {
      let buffer = "";
      const timer = setTimeout(
        () => reject(new Error("OpenCode server startup timed out")),
        options.startupTimeoutMs ?? 15000,
      );
      child.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("OpenCode server exited during startup"));
      });
      child.stdout.on("data", (bytes) => {
        buffer += bytes.toString();
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            const value = JSON.parse(line);
            const url = new URL(value.url);
            if (
              url.protocol === "http:" &&
              ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
            ) {
              clearTimeout(timer);
              accept(url.origin);
            }
          } catch {
            /* startup diagnostic */
          }
        }
        if (buffer.length > 65536) buffer = "";
      });
    });
    return {
      baseUrl,
      authorization:
        "Basic " + Buffer.from("opencode:" + password).toString("base64"),
      onExit: (listener) => {
        listeners.add(listener);
        if(exitReason && !closed)listener(exitReason);
      },
      close: async () => {
        closed = true;
        child.stdin.end();
        await lifeline.terminate();
      },
    };
  } catch (e) {
    closed = true;
    child.stdin.end();
    await lifeline.terminate();
    throw e;
  }
}
export class PrivateEndpoint implements OpenCodeEndpoint {
  private starting: Promise<void> | undefined;
  private server: OpenCodeServerHandle | undefined;
  private client: OpenCodeClient | undefined;
  private info: { version: string } | undefined;
  private generation = 0;
  private leases = 0;
  private idle: NodeJS.Timeout | undefined;
  private listeners = new Set<(reason: string) => void>();
  constructor(
    private deps: {
      createServer?: (
        options: OpenCodeServerStartOptions,
      ) => Promise<OpenCodeServerHandle>;
      fetch?: FetchLike;
      requestTimeoutMs?: number;
      startupTimeoutMs?: number;
      serverIdleShutdownMs?: number;
    } = {},
  ) {}
  async acquire(): Promise<EndpointLease> {
    if (this.idle) clearTimeout(this.idle);
    if (!this.server) {
      this.starting ??= (async () => {
        const server = await (this.deps.createServer ?? startOpenCodeServer)(
          this.deps,
        );
        const client = new OpenCodeClient(
          server.baseUrl,
          server.authorization,
          this.deps.fetch,
          this.deps.requestTimeoutMs,
        );
        try {
          this.info = await checkServerVersion(client);
        } catch (e) {
          await server.close();
          throw e;
        }
        this.server = server;
        this.client = client;
        this.generation++;
        server.onExit?.((reason) => {
          if (this.server !== server) return;
          this.server = undefined;
          for (const listener of this.listeners) listener(reason);
          this.listeners.clear();
        });
      })().finally(() => {
        this.starting = undefined;
      });
      await this.starting;
    }
    if(!this.server)throw new Error("OpenCode server exited during version negotiation; retry the launch.");
    this.leases++;
    const generation = this.generation;
    const server = this.server!;
    const listeners = new Set<(reason: string) => void>();
    let released = false;
    return {
      client: this.client!,
      info: this.info!,
      generation,
      baseUrl: server.baseUrl,
      authorization: server.authorization,
      onLost: (listener) => {
        listeners.add(listener);
        this.listeners.add(listener);
      },
      release: async () => {
        if (released) return;
        released = true;
        this.leases--;
        for (const l of listeners) this.listeners.delete(l);
        if (
          this.leases === 0 &&
          this.server === server &&
          generation === this.generation
        ) {
          this.idle = setTimeout(() => {
            if (this.leases === 0 && this.server === server) {
              this.server = undefined;
              void server.close();
            }
          }, this.deps.serverIdleShutdownMs ?? 30000);
          this.idle.unref();
        }
      },
    };
  }
}
