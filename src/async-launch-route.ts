import { canonicalizeSessionRoute, isDirectSessionRoute } from "./session-route";
import type { OpenClawPluginToolContext, SessionRoute } from "./types";

type RouteSource = {
  route?: SessionRoute;
  originChannel?: string;
  originThreadId?: string | number;
  originSessionKey?: string;
};

export type AsyncLaunchRouteResolution =
  | { kind: "resolved"; route: SessionRoute; recovered: boolean }
  | { kind: "error"; text: string };

function isIntentionalNonUserContext(ctx: OpenClawPluginToolContext): boolean {
  if (ctx.oneShotCliRun === true) return true;
  return Boolean(ctx.sessionKey?.includes(":cron:"));
}

/**
 * Validate routing before starting background work. The standalone deferred
 * plugin-tool bridge currently supplies only `{ config }`; that context has no
 * trustworthy invocation identity and must not be mistaken for a system run.
 */
export function resolveRequiredAsyncLaunchRoute(args: {
  ctx: OpenClawPluginToolContext;
  route?: SessionRoute;
  recoveredRouteSource?: RouteSource;
  operation: "coding session" | "goal task";
}): AsyncLaunchRouteResolution {
  const route = canonicalizeSessionRoute({ route: args.route });
  if (isDirectSessionRoute(route)) {
    return { kind: "resolved", route, recovered: false };
  }

  const recoveredRoute = args.recoveredRouteSource
    ? canonicalizeSessionRoute(args.recoveredRouteSource)
    : undefined;
  if (isDirectSessionRoute(recoveredRoute)) {
    return { kind: "resolved", route: recoveredRoute, recovered: true };
  }

  if (isIntentionalNonUserContext(args.ctx)) {
    return {
      kind: "resolved",
      route: route ?? { provider: "system", target: "system", sessionKey: args.ctx.sessionKey },
      recovered: false,
    };
  }

  return {
    kind: "error",
    text: [
      `Error: Cannot launch the asynchronous ${args.operation} because OpenClaw did not provide a trustworthy lifecycle delivery route.`,
      describeMissingDeliveryRoute(args.ctx, route),
      `Retry from the originating chat/session or update OpenClaw so nested plugin-tool invocations preserve ToolContext routing fields. No coding session was started.`,
    ].join(" "),
  };
}

/**
 * Name exactly what the invocation context lacks. The launch needs a direct
 * delivery route (a channel plus a conversation target); a session key alone is
 * not enough when it does not identify a chat conversation.
 */
function describeMissingDeliveryRoute(ctx: OpenClawPluginToolContext, route: SessionRoute | undefined): string {
  const hasSessionKey = Boolean(ctx.sessionKey?.trim());
  const channel = route?.provider && route.provider !== "system"
    ? route.provider
    : ctx.deliveryContext?.channel?.trim() || ctx.messageChannel?.split("|")[0]?.trim() || undefined;
  const missingRoute = channel
    ? `a delivery target: the "${channel}" channel was provided without a conversation to deliver to`
    : "a delivery route: no delivery context or message channel was provided"
      + (hasSessionKey ? ", and the session key does not identify a chat conversation" : "");
  const present = hasSessionKey ? "The invocation context has a session key but is missing" : "The invocation context is missing a session key and";
  const bridgeHint = hasSessionKey || channel
    ? ""
    : " (as occurs in the standalone deferred/nested plugin-tool bridge)";
  return `${present} ${missingRoute}${bridgeHint}.`;
}
