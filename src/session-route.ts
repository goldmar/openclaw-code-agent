import type { SessionRoute } from "./types";

function parseDiscordTargetKind(sessionKey?: string): "channel" | "user" | undefined {
  if (!sessionKey) return undefined;
  const match = sessionKey.match(/^agent:[^:]+:discord:(direct|dm|channel|group):/i);
  if (!match?.[1]) return undefined;
  const kind = match[1].toLowerCase();
  return kind === "direct" || kind === "dm" ? "user" : "channel";
}

function normalizeDiscordTarget(target: string, sessionKey?: string): string {
  if (!/^\d+$/.test(target)) return target;
  const kind = parseDiscordTargetKind(sessionKey);
  return kind ? `${kind}:${target}` : target;
}

export function routeFromOriginMetadata(
  originChannel?: string,
  originThreadId?: string | number,
  originSessionKey?: string,
): SessionRoute | undefined {
  const normalizedChannel = originChannel?.trim();
  if (!normalizedChannel || normalizedChannel === "unknown") {
    return {
      provider: "system",
      target: "system",
      sessionKey: originSessionKey?.trim() || undefined,
    };
  }

  const parts = normalizedChannel.split("|").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) {
    return {
      provider: "system",
      target: "system",
      sessionKey: originSessionKey?.trim() || undefined,
    };
  }

  const [provider, second, third] = parts;
  const rawTarget = third ?? second;
  const accountId = third ? second : undefined;
  if (!provider || !rawTarget) return undefined;

  const target = provider === "discord"
    ? normalizeDiscordTarget(rawTarget, originSessionKey)
    : rawTarget;

  return {
    provider,
    accountId,
    target,
    threadId: originThreadId != null ? String(originThreadId) : undefined,
    sessionKey: originSessionKey?.trim() || undefined,
  };
}
