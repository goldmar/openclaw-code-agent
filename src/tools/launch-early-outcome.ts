import type { Session } from "../session";
import type { SessionStatus } from "../types";
import { fenceAgentOutput } from "../untrusted-output";
import { truncateText } from "../format";

/** How long agent_launch waits for a session that ends right away (a bad model, a startup error). */
export const LAUNCH_EARLY_OUTCOME_WAIT_MS = 4_000;

/** Test seam: fake-harness suites set `waitMs` to 0 so every launch does not wait. */
export const launchEarlyOutcomeInternals = { waitMs: LAUNCH_EARLY_OUTCOME_WAIT_MS };
const EARLY_OUTCOME_PREVIEW_MAX_CHARS = 600;

const TERMINAL: ReadonlySet<SessionStatus> = new Set(["completed", "failed", "killed"]);

type EarlyOutcomeSession = Pick<Session, "id" | "name" | "status" | "error" | "getOutput" | "noteOutcomeSeen"> & {
  on?: Session["on"];
  off?: Session["off"];
};

/**
 * Wait briefly after a launch so a session that ends at once is reported in the
 * launch result itself, while the launching turn can still tell the user.
 * Returns early when the agent starts working (a tool call, or a wait for a
 * plan decision or an answer). An ended session is recorded as read by the
 * launching orchestrator session, which skips its deferred outcome wake.
 */
export async function awaitLaunchEarlyOutcome(
  session: EarlyOutcomeSession,
  readerSessionKey: string | undefined,
  waitMs: number = launchEarlyOutcomeInternals.waitMs,
): Promise<string | undefined> {
  if (!TERMINAL.has(session.status) && session.on && session.off && waitMs > 0) {
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        session.off?.("statusChange", onStatus);
        session.off?.("toolUse", done);
        session.off?.("lifecycleChange", onLifecycle);
        resolve();
      };
      const onStatus = (_s: unknown, status: SessionStatus): void => {
        if (TERMINAL.has(status)) done();
      };
      const onLifecycle = (_s: unknown, lifecycle: string): void => {
        if (lifecycle === "awaiting_plan_decision" || lifecycle === "awaiting_user_input") done();
      };
      const timer = setTimeout(done, waitMs);
      timer.unref?.();
      session.on?.("statusChange", onStatus);
      session.on?.("toolUse", done);
      session.on?.("lifecycleChange", onLifecycle);
    });
  }
  if (!TERMINAL.has(session.status)) return undefined;
  if (readerSessionKey) session.noteOutcomeSeen(readerSessionKey);
  const output = truncateText(session.getOutput(20).join("\n").trim(), EARLY_OUTCOME_PREVIEW_MAX_CHARS);
  if (session.status === "failed") {
    return [
      `⚠️ [${session.name}] failed right after launch (the user already sees the ❌ Failed notice). Tell the user the cause and your next step in this reply; no later wake repeats it.`,
      fenceAgentOutput(session.error?.trim() || output || "(no error text)", "failure summary"),
    ].join("\n");
  }
  if (session.status === "completed") {
    return [
      `[${session.name}] already finished (the user already sees the ✅ Completed notice). Tell the user what was done in this reply; no later wake repeats it.`,
      ...(output ? [fenceAgentOutput(output, "output preview")] : []),
    ].join("\n");
  }
  return `[${session.name}] was stopped right after launch (status: ${session.status}).`;
}
