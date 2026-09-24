import { getPluginRuntime } from "./runtime-store";

type LogLevel = "debug" | "info" | "warn" | "error";
type LogMethod = (message: string, ...details: unknown[]) => void;

export interface CodeAgentLogger {
  debug: LogMethod;
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
}

type HostLogger = {
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
};

const PLUGIN_ID = "openclaw-code-agent";
const hostLoggers = new WeakMap<object, Map<string, HostLogger | null>>();

function resolveHostLogger(subsystem: string): HostLogger | undefined {
  const runtime = getPluginRuntime();
  const getChildLogger = runtime?.logging?.getChildLogger;
  if (!runtime || typeof getChildLogger !== "function") return undefined;
  let bySubsystem = hostLoggers.get(runtime);
  if (!bySubsystem) {
    bySubsystem = new Map();
    hostLoggers.set(runtime, bySubsystem);
  }
  if (!bySubsystem.has(subsystem)) {
    let logger: HostLogger | null = null;
    try {
      logger = getChildLogger({ plugin: PLUGIN_ID, subsystem }) as HostLogger;
    } catch {
      logger = null;
    }
    bySubsystem.set(subsystem, logger);
  }
  return bySubsystem.get(subsystem) ?? undefined;
}

function formatDetail(detail: unknown): unknown {
  if (detail instanceof Error) return { name: detail.name, message: detail.message };
  return detail;
}

function writeConsole(level: LogLevel, message: string, details: unknown[]): void {
  // Fallback for tests and hosts without `runtime.logging`. The production bundle
  // strips console.log/info/warn/debug through esbuild `--pure`, so only the host
  // logger (or console.error) is observable there.
  if (level === "error") console.error(message, ...details);
  else if (level === "warn") console.warn(message, ...details);
  else if (level === "info") console.info(message, ...details);
  else console.debug(message, ...details);
}

/**
 * Subsystem logger that writes through the host's public
 * `api.runtime.logging.getChildLogger(...)` so plugin diagnostics land in the
 * Gateway log with OpenClaw's level filtering and redaction.
 */
export function createLogger(subsystem: string): CodeAgentLogger {
  const emit = (level: LogLevel): LogMethod => (message, ...details) => {
    const host = resolveHostLogger(subsystem);
    if (host) {
      const method = level === "debug" ? host.debug : host[level];
      if (typeof method === "function") {
        try {
          method.call(host, message, details.length > 0 ? { details: details.map(formatDetail) } : undefined);
          return;
        } catch {
          // Fall through to the console fallback when the host logger throws.
        }
      } else if (level === "debug") {
        return;
      }
    }
    writeConsole(level, message, details);
  };
  return {
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
  };
}
