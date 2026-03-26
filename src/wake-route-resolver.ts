import type { SessionRoute } from "./types";

export type NotificationRoute = {
  channel: string;
  target: string;
  accountId?: string;
  threadId?: string;
  sessionKey?: string;
};

type RoutableSession = {
  route?: SessionRoute;
};

export class WakeRouteResolver {
  resolve(session: RoutableSession): NotificationRoute | undefined {
    const route = session.route;
    if (!route?.provider || !route.target) return undefined;
    if (route.provider === "system" || route.target === "system") return undefined;
    return {
      channel: route.provider,
      target: route.target,
      accountId: route.accountId,
      threadId: route.threadId,
      sessionKey: route.sessionKey,
    };
  }

  summary(route?: NotificationRoute): string {
    if (!route) return "system";
    const account = route.accountId ? `|${route.accountId}` : "";
    const thread = route.threadId ? `#${route.threadId}` : "";
    return `${route.channel}${account}|${route.target}${thread}`;
  }
}
