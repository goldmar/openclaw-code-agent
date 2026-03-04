import { execFile } from "child_process";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import { Session } from "./session";
import { pluginConfig } from "./config";
import { formatDuration, generateSessionName, lastCompleteLines, truncateText } from "./format";
import type { NotificationService } from "./notifications";
import type { SessionConfig, SessionStatus, SessionMetrics, PersistedSessionInfo, KillReason } from "./types";
import { SessionStore } from "./session-store";
import { SessionMetricsRecorder } from "./session-metrics";
import { WakeDispatcher } from "./wake-dispatcher";
import { looksLikeWaitingForUser } from "./waiting-detector";

function resolveLobsterWorkflowPath(): string {
  const explicit = process.env.OPENCLAW_CODE_AGENT_PLAN_WORKFLOW_PATH?.trim();
  if (explicit) return explicit;

  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), "workflows", "plan-approval.lobster"),
    join(moduleDir, "..", "workflows", "plan-approval.lobster"),
    join(moduleDir, "..", "..", "workflows", "plan-approval.lobster"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  // Preserve historical behavior as best-effort fallback.
  return fileURLToPath(new URL("../workflows/plan-approval.lobster", import.meta.url));
}

const LOBSTER_WORKFLOW_PATH = resolveLobsterWorkflowPath();

const TERMINAL_STATUSES = new Set<SessionStatus>(["completed", "failed", "killed"]);
const KILLABLE_STATUSES = new Set<SessionStatus>(["starting", "running"]);
const WAITING_EVENT_DEBOUNCE_MS = 5_000;
const WAKE_CLI_TIMEOUT_MS = 30_000;

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  maxSessions: number;
  maxPersistedSessions: number;
  private _notifications: NotificationService | null = null;

  private lastWaitingEventTimestamps: Map<string, number> = new Map();
  private readonly store: SessionStore;
  private readonly metrics: SessionMetricsRecorder;
  private readonly wakeDispatcher: WakeDispatcher;

  constructor(maxSessions: number = 5, maxPersistedSessions: number = 50) {
    this.maxSessions = maxSessions;
    this.maxPersistedSessions = maxPersistedSessions;
    this.store = new SessionStore();
    this.metrics = new SessionMetricsRecorder();
    this.wakeDispatcher = new WakeDispatcher();
  }

  // Back-compat for tests and internal inspection.
  get persisted(): Map<string, PersistedSessionInfo> { return this.store.persisted; }
  get idIndex(): Map<string, string> { return this.store.idIndex; }
  get nameIndex(): Map<string, string> { return this.store.nameIndex; }

  set notifications(value: NotificationService | null) {
    this._notifications = value;
    this.wakeDispatcher.setNotifications(value);
  }

  get notifications(): NotificationService | null {
    return this._notifications;
  }

  private uniqueName(baseName: string): string {
    const activeNames = new Set(
      [...this.sessions.values()]
        .filter((s) => KILLABLE_STATUSES.has(s.status))
        .map((s) => s.name),
    );
    if (!activeNames.has(baseName)) return baseName;
    let i = 2;
    while (activeNames.has(`${baseName}-${i}`)) i++;
    return `${baseName}-${i}`;
  }

  spawn(config: SessionConfig): Session {
    const activeCount = [...this.sessions.values()].filter(
      (s) => KILLABLE_STATUSES.has(s.status),
    ).length;
    if (activeCount >= this.maxSessions) {
      throw new Error(`Max sessions reached (${this.maxSessions}). Use agent_sessions to list active sessions and agent_kill to end one.`);
    }

    const baseName = config.name || generateSessionName(config.prompt);
    const name = this.uniqueName(baseName);
    if (name !== baseName) {
      console.warn(`[SessionManager] Name conflict: "${baseName}" → "${name}" (active session with same name exists)`);
    }
    const session = new Session(config, name);
    this.sessions.set(session.id, session);
    this.metrics.incrementLaunched();

    if (this.notifications) {
      this.notifications.attachToSession(session);
    }

    // Wire event handlers for lifecycle management
    session.on("statusChange", (_s: Session, newStatus: SessionStatus) => {
      if (newStatus === "running" && session.harnessSessionId) {
        this.store.markRunning(session);
      } else if (TERMINAL_STATUSES.has(newStatus)) {
        this.onSessionTerminal(session);
      }
    });

    // `turnEnd` is the canonical signal for "turn is over" in multi-turn mode.
    // We wake the orchestrator even for non-question turns so it can inspect
    // output and decide whether to continue autonomous workflows.
    session.on("turnEnd", (_s: Session, hadQuestion: boolean) => {
      this.onTurnEnd(session, hadQuestion);
    });

    session.start();

    // Send launch notification
    if (this.notifications) {
      const launchText = `🚀 [${session.name}] Launched | ${session.workdir} | ${session.model ?? "default"}`;
      this.deliverToTelegram(session, launchText);
    }

    return session;
  }

  private onSessionTerminal(session: Session): void {
    this.persistSession(session);
    this.lastWaitingEventTimestamps.delete(session.id);

    // Multi-turn sessions that naturally end after a successful no-input turn
    // use reason "done". Turn-complete wake already fired for that turn.
    if (session.killReason === "done") return;

    if (session.status === "completed") {
      this.triggerAgentEvent(session);
      return;
    }

    // Failed or killed — informational Telegram notification
    const costStr = `$${(session.costUsd ?? 0).toFixed(2)}`;
    const duration = formatDuration(session.duration);

    let statusLabel: string;
    let errorSummary: string | undefined;

    if (session.status === "failed") {
      statusLabel = "Failed";
      const rawError = session.error
        || (session.result?.is_error && session.result.result)
        || (session.result?.result)
        || this.extractLastOutputLine(session)
        || `Session failed with no error details (session=${session.id}, subtype=${session.result?.subtype ?? "none"}, turns=${session.result?.num_turns ?? 0})`;
      errorSummary = truncateText(rawError, 200);
    } else {
      const reasonMap: Record<string, string> = {
        "user": "by agent/user",
        "idle-timeout": `idle ${pluginConfig.idleTimeoutMinutes ?? 15}min`,
        "unknown": "",
      };
      const killDetail = reasonMap[session.killReason] || "";
      statusLabel = `Killed${killDetail ? ` (${killDetail})` : ""}`;
    }

    const icon = session.status === "failed" ? "❌" : "⛔";
    const notificationText = [
      `${icon} [${session.name}] ${statusLabel} | ${costStr} | ${duration}`,
      ...(errorSummary ? [`   ⚠️ ${errorSummary}`] : []),
    ].join("\n");

    this.deliverToTelegram(session, notificationText);
  }

  private persistSession(session: Session): void {
    // Record metrics once
    const alreadyPersisted = this.store.hasRecordedSession(session.id);
    if (!alreadyPersisted) {
      this.metrics.recordSession(session);
    }

    this.store.persistTerminal(session);
  }

  getMetrics(): SessionMetrics { return this.metrics.getMetrics(); }

  // Back-compat helper retained for test access.
  private recordSessionMetrics(session: Session): void {
    this.metrics.recordSession(session);
  }

  // -- Wake / notification delivery --

  deliverToTelegram(session: Session, text: string): void {
    this.wakeDispatcher.deliverToTelegram(session, text);
  }

  // Back-compat helper retained for test access.
  private buildDeliverArgs(originChannel?: string, threadId?: string | number): string[] {
    return this.wakeDispatcher.buildDeliverArgs(originChannel, threadId);
  }

  /**
   * Run the Lobster plan-approval workflow as a structural gate.
   * Sends a direct Telegram notification with the plan summary and a resume token,
   * bypassing the orchestrator entirely. The user approves/rejects via Lobster's
   * approval mechanism which then calls agent_respond on the session.
   */
  private runLobsterApproval(session: Session, planSummary: string): void {
    const argsJson = JSON.stringify({
      session_id: session.id,
      session_name: session.name,
      plan_summary: planSummary,
    });

    const args = [
      "invoke", "--tool", "lobster",
      "--args-json", JSON.stringify({
        action: "run",
        pipeline: LOBSTER_WORKFLOW_PATH,
        argsJson,
        timeoutMs: 0, // No timeout — waits for human approval
      }),
    ];

    execFile("openclaw", args, { timeout: WAKE_CLI_TIMEOUT_MS }, (err, stdout) => {
      if (err) {
        console.error(`[SessionManager] Lobster launch failed for session=${session.id}: ${err.message}`);
        // Fallback: send Telegram directly so the user isn't left in the dark
        this.deliverToTelegram(session, `📋 [${session.name}] Plan ready — Lobster gate failed, please review manually:\n\n${truncateText(planSummary, 800)}`);
        return;
      }

      // Parse the Lobster response to get the resume token
      let resumeToken: string | undefined;
      try {
        const response = JSON.parse(stdout.trim());
        resumeToken = response?.requiresApproval?.resumeToken
          ?? response?.details?.requiresApproval?.resumeToken;
      } catch {
        console.warn(`[SessionManager] Could not parse Lobster response for session=${session.id}: ${stdout?.substring(0, 200)}`);
      }

      // Store token on session for programmatic resume via agent_respond
      if (resumeToken) {
        session.lobsterResumeToken = resumeToken;
      }

      // Send Telegram notification with plan summary
      const telegramLines = [
        `📋 [${session.name}] Plan ready for approval`,
        ``,
        truncateText(planSummary, 1200),
        ``,
        `Session: ${session.name} (${session.id})`,
        ``,
        `To approve: reply "approve"`,
        `To reject: reply with feedback`,
      ];
      this.deliverToTelegram(session, telegramLines.join("\n"));
    });
  }

  /**
   * Resume (or cancel) a Lobster approval workflow by token.
   * Calls `openclaw invoke --tool lobster` with the resume action.
   */
  resumeLobsterApproval(token: string, approve: boolean): Promise<void> {
    const timeoutMs = approve ? 30_000 : 10_000;
    return new Promise<void>((resolve, reject) => {
      const args = [
        "invoke", "--tool", "lobster",
        "--args-json", JSON.stringify({ action: "resume", token, approve }),
      ];
      execFile("openclaw", args, { timeout: timeoutMs }, (err) => {
        if (err) {
          console.error(`[SessionManager] Lobster resume failed (approve=${approve}): ${err.message}`);
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /** Returns true if the event should proceed; false if debounced. */
  private debounceWaitingEvent(sessionId: string): boolean {
    const now = Date.now();
    const lastTs = this.lastWaitingEventTimestamps.get(sessionId);
    if (lastTs && now - lastTs < WAITING_EVENT_DEBOUNCE_MS) return false;
    this.lastWaitingEventTimestamps.set(sessionId, now);
    return true;
  }

  private originThreadLine(session: Session): string {
    return session.originThreadId != null
      ? `Session origin thread: ${session.originThreadId}`
      : "";
  }

  private extractLastOutputLine(session: Session): string | undefined {
    const lines = session.getOutput(3);
    const last = lines.filter(l => l.trim()).pop()?.trim();
    return last || undefined;
  }

  private getOutputPreview(session: Session, maxChars: number = 1000): string {
    const raw = session.getOutput(20).join("\n");
    return raw.length > maxChars ? lastCompleteLines(raw, maxChars) : raw;
  }

  private triggerAgentEvent(session: Session): void {
    const preview = this.getOutputPreview(session);

    const eventText = [
      `Coding agent session completed.`,
      `Name: ${session.name} | ID: ${session.id}`,
      `Status: ${session.status}`,
      this.originThreadLine(session),
      ``,
      `Output preview:`,
      preview,
      ``,
      `[ACTION REQUIRED] Follow your autonomy rules for session completion:`,
      `1. Use agent_output(session='${session.id}', full=true) to read the full result.`,
      `2. If this is part of a multi-phase pipeline, launch the next phase NOW — do not wait for user input.`,
      `3. Notify the user with a summary of what was done.`,
    ].join("\n");

    const costStr = `$${(session.costUsd ?? 0).toFixed(2)}`;
    const duration = formatDuration(session.duration);
    const telegramText = `✅ [${session.name}] Completed | ${costStr} | ${duration}`;

    this.wakeDispatcher.wakeAgent(session, eventText, telegramText, "completed");
  }

  private triggerWaitingForInputEvent(session: Session): void {
    if (!this.debounceWaitingEvent(session.id)) return;

    const preview = this.getOutputPreview(session);
    const isPlanApproval = session.pendingPlanApproval;

    const telegramText = isPlanApproval
      ? `📋 [${session.name}] Plan ready for review:\n\n${preview}\n\nReply to approve or provide feedback.`
      : `🔔 [${session.name}] Waiting for input`;

    let eventText: string;
    if (isPlanApproval) {
      const planApprovalMode = pluginConfig.planApproval ?? "delegate";
      if (planApprovalMode === "ask") {
        // ASK mode: bypass the orchestrator entirely. Use Lobster's approval: required
        // to create a hard structural gate. Send the user a direct Telegram
        // notification with the plan summary. On approve/reject, Lobster
        // calls agent_respond on the session directly.
        this.runLobsterApproval(session, preview);
        return; // Do NOT wake the orchestrator — Lobster handles the full flow
      } else if (planApprovalMode === "delegate") {
        eventText = [
          `[DELEGATED PLAN APPROVAL] Coding agent session has finished its plan and is requesting approval to implement.`,
          `Name: ${session.name} | ID: ${session.id}`,
          this.originThreadLine(session),
          `Permission mode: plan → will switch to bypassPermissions on approval`,
          ``,
          `⚠️ YOU MUST COMPLETE THESE STEPS IN ORDER. Do NOT skip any step.`,
          ``,
          `━━━ STEP 1 (MANDATORY): Read the full plan ━━━`,
          `Call agent_output(session='${session.id}', full=true) to read the FULL plan output.`,
          `The preview below is truncated — you MUST read the full output before making any decision.`,
          ``,
          `Preview (truncated):`,
          preview,
          ``,
          `━━━ STEP 2 (MANDATORY): Notify the user ━━━`,
          `After reading the full plan, use the message tool to send the user a summary that includes:`,
          `- What files/components will be changed`,
          `- Risk level (low/medium/high) and why`,
          `- Scope: does this match the original task or has it expanded?`,
          `- Any concerns or assumptions the plan makes`,
          `This message creates accountability — you cannot approve blindly.`,
          ``,
          `━━━ STEP 3 (ONLY AFTER steps 1 and 2): Decide ━━━`,
          `You are the delegated decision-maker. Choose ONE:`,
          ``,
          `APPROVE the plan directly if ALL of the following are true:`,
          `- You have read the FULL plan (not just the preview)`,
          `- You have sent the user the summary message`,
          `- The plan scope matches the original task request`,
          `- The changes are low-risk (no destructive operations, no credential handling, no production deployments)`,
          `- The plan is clear and well-scoped (no ambiguous requirements or open design questions)`,
          `- No architectural decisions that the user should weigh in on`,
          `- The working directory and codebase are correct`,
          ``,
          `ESCALATE to the user and WAIT if ANY of the following are true:`,
          `- The plan involves destructive operations (deleting files, dropping tables, force-pushing)`,
          `- The plan involves credentials, secrets, or production environments`,
          `- The plan requires architectural decisions not covered by the original task`,
          `- The scope has expanded beyond the original request`,
          `- The requirements are ambiguous or the plan makes assumptions the user should confirm`,
          `- You are unsure — when in doubt, always escalate`,
          ``,
          `If approving: agent_respond(session='${session.id}', message='Approved. Go ahead.', approve=true)`,
          `If escalating: tell the user you need their decision and WAIT for his explicit response.`,
          `To request changes: agent_respond(session='${session.id}', message='<your feedback>') — do NOT set approve=true. The agent will revise the plan.`,
        ].join("\n");
      } else {
        // approve mode — always auto-approve
        eventText = [
          `[AUTO-APPROVE] Session has a plan ready. Approve it now:`,
          `agent_respond(session='${session.id}', message='Approved. Go ahead.', approve=true)`,
        ].join("\n");
      }
    } else {
      const sessionType = session.multiTurn ? "Multi-turn session" : "Session";
      eventText = [
        `[SYSTEM INSTRUCTION: Follow your auto-respond rules strictly. If this is a permission request or "should I continue?" → auto-respond. For ALL other questions → forward the agent's EXACT question to the user. Do NOT add your own analysis, commentary, or interpretation. Do NOT "nudge" or "poke" the session.]`,
        ``,
        `${sessionType} is waiting for input.`,
        `Name: ${session.name} | ID: ${session.id}`,
        this.originThreadLine(session),
        ``,
        `Last output:`,
        preview,
        ``,
        `Use agent_respond(session='${session.id}', message='...') to send a reply, or agent_output(session='${session.id}', full: true) to see full context before deciding.`,
      ].join("\n");
    }

    this.wakeDispatcher.wakeAgent(session, eventText, telegramText, isPlanApproval ? "plan-approval" : "waiting");
  }

  private onTurnEnd(session: Session, hadQuestion: boolean): void {
    if (session.notifyOnTurnEnd === false) return;

    // Use the dedicated waiting path for explicit question/plan-approval turns.
    // This preserves plan approval policy handling and waiting-specific guidance.
    if (hadQuestion || session.pendingPlanApproval) {
      this.triggerWaitingForInputEvent(session);
      return;
    }

    // Non-question turns still emit a lightweight turn-complete wake. We keep
    // a heuristic waiting hint in that payload as a fallback.
    this.triggerTurnCompleteEventWithSignal(session);
  }

  private triggerTurnCompleteEventWithSignal(session: Session): void {
    const preview = this.getOutputPreview(session);
    // Heuristic fallback only: explicit waiting turns should already route via
    // `triggerWaitingForInputEvent`. This hint helps catch plain-text asks
    // without introducing high false-positive wake churn.
    const waitingForInput = looksLikeWaitingForUser(preview);
    const costStr = `$${(session.costUsd ?? 0).toFixed(2)}`;
    const waitingText = waitingForInput ? "yes" : "no";
    const telegramText = `🔄 [${session.name}] Turn done | ${costStr} | Waiting input: ${waitingText}`;

    const eventText = [
      `Coding agent session turn ended.`,
      `Name: ${session.name}`,
      `ID: ${session.id}`,
      `Status: ${session.status}`,
      ``,
      `Looks like waiting for user input: ${waitingText}`,
      ``,
      `Last output (~20 lines):`,
      preview,
      ...(this.originThreadLine(session) ? ["", this.originThreadLine(session)] : []),
    ].join("\n");

    this.wakeDispatcher.wakeAgent(session, eventText, telegramText, "turn-complete");
  }

  // -- Public API --

  resolve(idOrName: string): Session | undefined {
    const byId = this.sessions.get(idOrName);
    if (byId) return byId;

    const matches = [...this.sessions.values()].filter((s) => s.name === idOrName);
    if (matches.length === 0) return undefined;

    const activeMatches = matches.filter((s) => KILLABLE_STATUSES.has(s.status));
    if (activeMatches.length > 0) {
      return activeMatches.sort((a, b) => b.startedAt - a.startedAt)[0];
    }

    return matches.sort((a, b) => b.startedAt - a.startedAt)[0];
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(filter?: SessionStatus | "all"): Session[] {
    let result = [...this.sessions.values()];
    if (filter && filter !== "all") {
      result = result.filter((s) => s.status === filter);
    }
    return result.sort((a, b) => b.startedAt - a.startedAt);
  }

  kill(id: string, reason?: KillReason): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.kill(reason ?? "user");
    return true;
  }

  killAll(): void {
    for (const session of this.sessions.values()) {
      if (KILLABLE_STATUSES.has(session.status)) {
        this.kill(session.id);
      }
    }
    this.wakeDispatcher.clearPendingRetries();
  }

  resolveHarnessSessionId(ref: string): string | undefined {
    const active = this.resolve(ref);
    return this.store.resolveHarnessSessionId(ref, active?.harnessSessionId);
  }

  getPersistedSession(ref: string): PersistedSessionInfo | undefined {
    return this.store.getPersistedSession(ref);
  }

  listPersistedSessions(): PersistedSessionInfo[] {
    return this.store.listPersistedSessions();
  }

  cleanup(): void {
    const now = Date.now();
    // GC only evicts terminal sessions from the runtime in-memory map.
    // Persisted entries stay in SessionStore for resume/list/output lookups.
    // "evicted from runtime cache" means removed from `this.sessions`, not lost.
    const cleanupMaxAgeMs = (pluginConfig.sessionGcAgeMinutes ?? 1440) * 60_000;
    for (const [id, session] of this.sessions) {
      if (this.store.shouldGcActiveSession(session, now, cleanupMaxAgeMs)) {
        this.persistSession(session);
        this.sessions.delete(id);
        this.lastWaitingEventTimestamps.delete(id);
      }
    }

    this.store.cleanupTmpOutputFiles(now);
    this.store.evictOldestPersisted(this.maxPersistedSessions);
  }
}
