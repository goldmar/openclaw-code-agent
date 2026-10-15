import type { S_Permission_Ruleset } from "./protocol/api";
export function rulesForMode(mode = "default"): S_Permission_Ruleset {
  const actions =
    mode === "plan"
      ? ["shell", "external_directory", "subagent"]
      : ["edit", "shell", "subagent", "external_directory"];
  return actions.map((action) => ({
    action,
    resource: "*",
    effect:
      mode === "plan" ? "deny" : mode === "bypassPermissions" ? "allow" : "ask",
  }));
}
export function agentForMode(mode: string, defaultAgent = "build"): string {
  return mode === "plan" ? "plan" : defaultAgent;
}
