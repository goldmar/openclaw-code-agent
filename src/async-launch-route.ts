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
  if (ctx.workspaceDir?.trim()) return true;
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
      `The invocation context is missing session, delivery, and workspace identity (as occurs in the standalone deferred/nested plugin-tool bridge).`,
      `Retry from the originating chat/session or update OpenClaw so nested plugin-tool invocations preserve ToolContext routing fields. No coding session was started.`,
    ].join(" "),
  };
}
