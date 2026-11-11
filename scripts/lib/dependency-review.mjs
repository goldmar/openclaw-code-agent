// CLI attestation; shared GitHub policy stays in the standalone preparation script.
import { REVIEW_MODEL, REVIEW_MARKER, collectReview, budgetExhausted, claudeReceipt, githubRead } from "../dependency-maintenance.mjs";
export { REVIEW_MODEL, REVIEW_MARKER, collectReview, budgetExhausted, claudeReceipt };
export const readGithub = githubRead;
const REPO = "goldmar/openclaw-code-agent";
const canonicalModel = value => String(value ?? "").replace(/-\d{8}$/u, "");

export function parseClaudeReview(stdout, identity) {
  const events = stdout.trim().split("\n").map(line => JSON.parse(line));
  const init = events.find(e => e.type === "system" && e.subtype === "init");
  const result = events.findLast(e => e.type === "result");
  const models = Object.keys(result?.modelUsage ?? {}).map(canonicalModel);
  const assistants = events.filter(e => e.type === "assistant").map(e => canonicalModel(e.message?.model));
  if (canonicalModel(init?.model) !== REVIEW_MODEL || !/^\d+\.\d+\.\d+$/u.test(init?.claude_code_version ?? "") ||
      init?.apiKeySource !== "none" ||
      !Array.isArray(init?.mcp_servers) || init.mcp_servers.length ||
      !Array.isArray(init?.tools) || init.tools.some(t => t !== "StructuredOutput") ||
      result?.subtype !== "success" || result.is_error !== false ||
      assistants.length < 1 || models.length !== 1 || models[0] !== REVIEW_MODEL || assistants.some(m => m !== REVIEW_MODEL)) throw new Error("Claude model/transport unproven");
  const value = result.structured_output;
  if (!value || value.head !== identity.head || value.base !== identity.base ||
      value.verdict !== "clean" || !Array.isArray(value.findings) || value.findings.length) throw new Error("Claude review is not clean");
  return { schema: REVIEW_MARKER, repo: REPO, ...identity, reviewer: "claude", model: REVIEW_MODEL,
    transport: "claude-cli", reason: "greptile-budget-exhausted", cliVersion: init.claude_code_version,
    reviewedAt: new Date().toISOString(), verdict: "clean", findings: [] };
}
