import type {
  AgentHarness,
  HarnessLaunchOptions,
  HarnessSession,
} from "../types";
import type { ThreadAction } from "../../types";
import { PrivateEndpoint } from "./endpoint-private";
import type { OpenCodeEndpoint } from "./endpoint";
import { EventHub } from "./event-hub";
import { launchOpenCodeSession } from "./session";
export {
  startOpenCodeServer,
  privateServerEnvironment,
} from "./endpoint-private";
export type { OpenCodeServerStartOptions } from "./endpoint-private";
export type { OpenCodeServerHandle } from "./endpoint";
export { isConnectionResetError } from "./errors";
export { candidateSearchPaths, resolveCommandPath } from "./command";
export { rulesForMode as permissionRulesForMode } from "./permissions";
export type OpenCodeHarnessDeps = ConstructorParameters<
  typeof PrivateEndpoint
>[0] & {
  endpoint?: OpenCodeEndpoint;
  turnTimeoutMs?: number;
  streamReconnectDelayMs?: number;
};
export class OpenCodeHarness implements AgentHarness {
  readonly name = "opencode";
  readonly backendKind = "opencode-v2" as const;
  readonly supportedPermissionModes = [
    "default",
    "plan",
    "bypassPermissions",
  ] as const;
  readonly capabilities = {
    nativePendingInput: true,
    nativePlanArtifacts: false,
    nativePlanDecisions: true,
    threadActions: ["compact"] as const,
  };
  private endpoint: OpenCodeEndpoint;
  private hubs = new Map<number, EventHub>();
  constructor(private deps: OpenCodeHarnessDeps = {}) {
    this.endpoint = deps.endpoint ?? new PrivateEndpoint(deps);
  }
  launch(options: HarnessLaunchOptions): HarnessSession {
    return launchOpenCodeSession(options, {
      ...this.deps,
      endpoint: this.endpoint,
      hubs: this.hubs,
    });
  }
  buildUserMessage(text: string, sessionId: string): unknown {
    return {
      type: "user",
      session_id: sessionId,
      message: { role: "user", content: text },
    };
  }
  buildThreadActionMessage(action: ThreadAction): unknown {
    if (action.kind !== "compact")
      throw new Error("OpenCode supports compact only");
    return { ocaAction: "compact" };
  }
}
